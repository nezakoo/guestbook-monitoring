import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import * as fs from "fs";

const config = new pulumi.Config();
// minikube doesn't support LoadBalancer, so we fall back to NodePort
const isMinikube = config.getBoolean("isMinikube") ?? false;

// --- Namespaces ---

const appNs = new k8s.core.v1.Namespace("guestbook", {
    metadata: { name: "guestbook" },
});

const monNs = new k8s.core.v1.Namespace("monitoring", {
    metadata: { name: "monitoring" },
});

// --- Guestbook app (straight port of the upstream example with scrape annotations added) ---

const redisLeaderLabels = { app: "redis", role: "leader" };

new k8s.apps.v1.Deployment("redis-leader", {
    metadata: { namespace: appNs.metadata.name },
    spec: {
        selector: { matchLabels: redisLeaderLabels },
        replicas: 1,
        template: {
            metadata: {
                labels: redisLeaderLabels,
                annotations: { "prometheus.io/scrape": "false" }, // redis doesn't expose /metrics by default
            },
            spec: {
                containers: [{
                    name: "redis-leader",
                    image: "redis:7-alpine",
                    ports: [{ containerPort: 6379 }],
                    resources: {
                        requests: { cpu: "100m", memory: "128Mi" },
                        limits: { cpu: "250m", memory: "256Mi" },
                    },
                }],
            },
        },
    },
}, { dependsOn: appNs });

const redisLeaderSvc = new k8s.core.v1.Service("redis-leader", {
    metadata: {
        namespace: appNs.metadata.name,
        labels: redisLeaderLabels,
    },
    spec: {
        selector: redisLeaderLabels,
        ports: [{ port: 6379, targetPort: 6379 }],
    },
});

const redisReplicaLabels = { app: "redis", role: "replica" };

new k8s.apps.v1.Deployment("redis-replica", {
    metadata: { namespace: appNs.metadata.name },
    spec: {
        selector: { matchLabels: redisReplicaLabels },
        replicas: 2,
        template: {
            metadata: {
                labels: redisReplicaLabels,
                annotations: { "prometheus.io/scrape": "false" },
            },
            spec: {
                containers: [{
                    name: "redis-replica",
                    image: "redis:7-alpine",
                    command: ["redis-server", "--replicaof", "redis-leader", "6379"],
                    ports: [{ containerPort: 6379 }],
                    resources: {
                        requests: { cpu: "100m", memory: "128Mi" },
                        limits: { cpu: "250m", memory: "256Mi" },
                    },
                }],
            },
        },
    },
}, { dependsOn: [appNs, redisLeaderSvc] });

new k8s.core.v1.Service("redis-replica", {
    metadata: {
        namespace: appNs.metadata.name,
        labels: redisReplicaLabels,
    },
    spec: {
        selector: redisReplicaLabels,
        ports: [{ port: 6379, targetPort: 6379 }],
    },
});

const frontendLabels = { app: "guestbook", tier: "frontend" };

new k8s.apps.v1.Deployment("frontend", {
    metadata: { namespace: appNs.metadata.name },
    spec: {
        selector: { matchLabels: frontendLabels },
        replicas: 3,
        template: {
            metadata: {
                labels: frontendLabels,
                // the upstream gb-frontend image doesn't expose a /metrics endpoint (it just
                // serves the PHP app on port 80), so annotation-based scraping of this pod
                // would only ever return HTML and error out in Prometheus. Leaving it false
                // and getting real per-container CPU/memory usage from cAdvisor instead
                // (see the kubernetes-cadvisor job below).
                annotations: {
                    "prometheus.io/scrape": "false",
                },
            },
            spec: {
                containers: [{
                    name: "php-redis",
                    image: "gcr.io/google-samples/gb-frontend:v5",
                    env: [{ name: "GET_HOSTS_FROM", value: "dns" }],
                    ports: [{ containerPort: 80 }],
                    resources: {
                        requests: { cpu: "100m", memory: "100Mi" },
                        limits: { cpu: "500m", memory: "512Mi" },
                    },
                }],
            },
        },
    },
}, { dependsOn: appNs });

const frontendSvc = new k8s.core.v1.Service("frontend", {
    metadata: {
        namespace: appNs.metadata.name,
        labels: frontendLabels,
    },
    spec: {
        selector: frontendLabels,
        ports: [{ port: 80, targetPort: 80 }],
        type: isMinikube ? "NodePort" : "LoadBalancer",
    },
});

// --- Prometheus ---

// RBAC so Prometheus can discover pods/services across namespaces
const promSA = new k8s.core.v1.ServiceAccount("prometheus", {
    metadata: { name: "prometheus", namespace: monNs.metadata.name },
}, { dependsOn: monNs });

const promCR = new k8s.rbac.v1.ClusterRole("prometheus", {
    metadata: { name: "prometheus" },
    rules: [
        {
            apiGroups: [""],
            resources: ["nodes", "nodes/proxy", "services", "endpoints", "pods"],
            verbs: ["get", "list", "watch"],
        },
        {
            nonResourceURLs: ["/metrics"],
            verbs: ["get"],
        },
    ],
});

new k8s.rbac.v1.ClusterRoleBinding("prometheus", {
    metadata: { name: "prometheus" },
    roleRef: {
        apiGroup: "rbac.authorization.k8s.io",
        kind: "ClusterRole",
        name: promCR.metadata.name,
    },
    subjects: [{
        kind: "ServiceAccount",
        name: promSA.metadata.name,
        namespace: monNs.metadata.name,
    }],
});

const promConfig = new k8s.core.v1.ConfigMap("prometheus-config", {
    metadata: { name: "prometheus-config", namespace: monNs.metadata.name },
    data: {
        "prometheus.yml": `
global:
  scrape_interval: 15s

scrape_configs:
  - job_name: prometheus
    static_configs:
      - targets: ['localhost:9090']

  # discover pods with prometheus.io/scrape=true
  - job_name: kubernetes-pods
    kubernetes_sd_configs:
      - role: pod
    relabel_configs:
      - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_scrape]
        action: keep
        regex: "true"
      - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_path]
        action: replace
        target_label: __metrics_path__
        regex: (.+)
      - source_labels: [__address__, __meta_kubernetes_pod_annotation_prometheus_io_port]
        action: replace
        target_label: __address__
        regex: ([^:]+)(?::\\d+)?;(\\d+)
        replacement: $1:$2
      - action: labelmap
        regex: __meta_kubernetes_pod_label_(.+)
      - source_labels: [__meta_kubernetes_namespace]
        target_label: namespace
      - source_labels: [__meta_kubernetes_pod_name]
        target_label: pod

  # per-container CPU/memory usage, via cAdvisor, proxied through the
  # API server so this works the same on minikube as on a real cluster (no
  # direct kubelet access needed). This uses the token/CA that Prometheus's
  # own pod already has mounted from its service account.
  - job_name: kubernetes-cadvisor
    scheme: https
    kubernetes_sd_configs:
      - role: node
    tls_config:
      ca_file: /var/run/secrets/kubernetes.io/serviceaccount/ca.crt
      insecure_skip_verify: true
    bearer_token_file: /var/run/secrets/kubernetes.io/serviceaccount/token
    relabel_configs:
      - action: labelmap
        regex: __meta_kubernetes_node_label_(.+)
      - target_label: __address__
        replacement: kubernetes.default.svc:443
      - source_labels: [__meta_kubernetes_node_name]
        target_label: __metrics_path__
        replacement: /api/v1/nodes/\${1}/proxy/metrics/cadvisor
    metric_relabel_configs:
      # keep this job's series limited to the guestbook namespace, otherwise
      # it pulls in cadvisor metrics for every pod on the node
      - source_labels: [namespace]
        regex: guestbook
        action: keep
`,
    },
}, { dependsOn: monNs });

new k8s.apps.v1.Deployment("prometheus", {
    metadata: { name: "prometheus", namespace: monNs.metadata.name },
    spec: {
        replicas: 1,
        selector: { matchLabels: { app: "prometheus" } },
        template: {
            metadata: { labels: { app: "prometheus" } },
            spec: {
                serviceAccountName: promSA.metadata.name,
                containers: [{
                    name: "prometheus",
                    image: "prom/prometheus:v2.51.0",
                    args: [
                        "--config.file=/etc/prometheus/prometheus.yml",
                        "--storage.tsdb.path=/prometheus",
                        "--web.enable-lifecycle",
                    ],
                    ports: [{ containerPort: 9090 }],
                    volumeMounts: [
                        { name: "config", mountPath: "/etc/prometheus" },
                        { name: "data", mountPath: "/prometheus" },
                    ],
                    resources: {
                        requests: { cpu: "200m", memory: "256Mi" },
                        limits: { cpu: "500m", memory: "512Mi" },
                    },
                }],
                volumes: [
                    { name: "config", configMap: { name: promConfig.metadata.name } },
                    { name: "data", emptyDir: {} },
                ],
            },
        },
    },
});

const promSvc = new k8s.core.v1.Service("prometheus", {
    metadata: { name: "prometheus", namespace: monNs.metadata.name },
    spec: {
        selector: { app: "prometheus" },
        ports: [{ port: 9090, targetPort: 9090 }],
    },
});

// --- Grafana ---

const grafanaDatasources = new k8s.core.v1.ConfigMap("grafana-datasources", {
    metadata: { name: "grafana-datasources", namespace: monNs.metadata.name },
    data: {
        "datasources.yaml": `
apiVersion: 1
datasources:
  - name: Prometheus
    uid: prometheus-ds
    type: prometheus
    access: proxy
    url: http://prometheus.monitoring.svc.cluster.local:9090
    isDefault: true
`,
    },
}, { dependsOn: monNs });

// load dashboard from file rather than inlining it
const dashboardJson = fs.readFileSync("dashboards/guestbook.json", "utf-8");

const grafanaDashboardsCM = new k8s.core.v1.ConfigMap("grafana-dashboards", {
    metadata: { name: "grafana-dashboards", namespace: monNs.metadata.name },
    data: {
        "provider.yaml": `
apiVersion: 1
providers:
  - name: default
    type: file
    options:
      path: /var/lib/grafana/dashboards
`,
        "guestbook.json": dashboardJson,
    },
});

const grafanaAdminPass = "admin";

new k8s.apps.v1.Deployment("grafana", {
    metadata: { name: "grafana", namespace: monNs.metadata.name },
    spec: {
        replicas: 1,
        selector: { matchLabels: { app: "grafana" } },
        template: {
            metadata: { labels: { app: "grafana" } },
            spec: {
                containers: [{
                    name: "grafana",
                    image: "grafana/grafana:10.4.2",
                    ports: [{ containerPort: 3000 }],
                    env: [
                        { name: "GF_SECURITY_ADMIN_USER", value: "admin" },
                        { name: "GF_SECURITY_ADMIN_PASSWORD", value: grafanaAdminPass },
                        { name: "GF_USERS_ALLOW_SIGN_UP", value: "false" },
                    ],
                    volumeMounts: [
                        { name: "datasources", mountPath: "/etc/grafana/provisioning/datasources" },
                        {
                            name: "dashboards-provider",
                            mountPath: "/etc/grafana/provisioning/dashboards",
                        },
                        {
                            name: "dashboards-json",
                            mountPath: "/var/lib/grafana/dashboards",
                        },
                        { name: "storage", mountPath: "/var/lib/grafana" },
                    ],
                    resources: {
                        requests: { cpu: "100m", memory: "128Mi" },
                        limits: { cpu: "250m", memory: "256Mi" },
                    },
                }],
                volumes: [
                    {
                        name: "datasources",
                        configMap: { name: grafanaDatasources.metadata.name },
                    },
                    {
                        name: "dashboards-provider",
                        configMap: {
                            name: grafanaDashboardsCM.metadata.name,
                            items: [{ key: "provider.yaml", path: "provider.yaml" }],
                        },
                    },
                    {
                        name: "dashboards-json",
                        configMap: {
                            name: grafanaDashboardsCM.metadata.name,
                            items: [{ key: "guestbook.json", path: "guestbook.json" }],
                        },
                    },
                    { name: "storage", emptyDir: {} },
                ],
            },
        },
    },
}, { dependsOn: [grafanaDatasources, grafanaDashboardsCM, promSvc] });

const grafanaSvc = new k8s.core.v1.Service("grafana", {
    metadata: { name: "grafana", namespace: monNs.metadata.name },
    spec: {
        selector: { app: "grafana" },
        ports: [{ port: 3000, targetPort: 3000 }],
        type: isMinikube ? "NodePort" : "LoadBalancer",
    },
});

// --- Outputs ---

export const frontendIp = frontendSvc.status.apply(s =>
    s.loadBalancer?.ingress?.[0]?.ip ?? "use: kubectl port-forward svc/frontend 8080:80 -n guestbook"
);

export const grafanaUrl = grafanaSvc.status.apply(s =>
    s.loadBalancer?.ingress?.[0]?.ip
        ? `http://${s.loadBalancer.ingress[0].ip}:3000`
        : "use: kubectl port-forward svc/grafana 3000:3000 -n monitoring"
);

export const grafanaUser = "admin";
export const grafanaPassword = grafanaAdminPass;
