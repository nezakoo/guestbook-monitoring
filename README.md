# Guestbook with Monitoring

Extends the [Pulumi Kubernetes Guestbook example](https://github.com/pulumi/examples/blob/master/kubernetes-ts-guestbook/README.md) with Prometheus and Grafana.

## What's added

- Prometheus deployed to the `monitoring` namespace, scraping two things:
  - **Annotation-based pod discovery** (`prometheus.io/scrape: "true"`) for any app pod that exposes its own `/metrics` endpoint. The guestbook frontend image (`gb-frontend:v5`) doesn't expose one -- it's a plain PHP app with no instrumentation -- so its annotation is set to `false` rather than pointing Prometheus at an endpoint that just returns HTML.
  - **cAdvisor**, proxied through the Kubernetes API server (`/api/v1/nodes/<node>/proxy/metrics/cadvisor`), for real per-container CPU and memory usage. This is what powers the "resource usage" requirement, and it works without needing direct kubelet access or a separate exporter -- useful on minikube and on a real cluster alike.
- Grafana with a pre-provisioned Prometheus datasource and a Guestbook dashboard (4 panels: CPU, memory, running containers, target health)
- RBAC (ClusterRole/ClusterRoleBinding) so Prometheus can discover pods and nodes, and read the cAdvisor proxy endpoint
- The guestbook app itself (redis-leader, redis-replica, frontend) is unchanged from the original example -- just moved into the `guestbook` namespace

## A note on "request" metrics

The assignment mentions exposing "number of requests or resource usage." The stock `gb-frontend` image doesn't emit request counts anywhere, so rather than fake it, the dashboard reports real per-container CPU and memory usage (from cAdvisor), plus a running-container count and Prometheus target health. That covers the "resource usage" half of the requirement with actual data.

I looked at adding per-pod network I/O as a rough proxy for request activity, since HTTP traffic shows up as network traffic even without app-level instrumentation. On this test cluster (minikube, Docker driver, arm64), cAdvisor doesn't expose `container_network_*` metrics at all -- confirmed directly against Prometheus, the series just isn't there in this environment. Rather than ship a dashboard panel that reads "No data," I left it out.

The honest long-term fix is adding a `/metrics` endpoint to the frontend (e.g. via a Prometheus client library), so Prometheus can report real request counts and latencies instead of a resource-usage proxy.

## Prerequisites

- Pulumi CLI
- Node.js 18+
- kubectl pointing at a running cluster (minikube works fine)

## Deploy

```bash
npm install

pulumi stack init dev

# if using minikube
pulumi config set isMinikube true

pulumi up
```

## Grafana access

| | |
|---|---|
| URL | see `grafanaUrl` output, or port-forward below |
| Username | `admin` |
| Password | `admin` |

If you're on minikube or the service doesn't get an external IP:

```bash
kubectl port-forward svc/grafana 3000:3000 -n monitoring
```

Then open http://localhost:3000. The Guestbook dashboard is under Dashboards > Guestbook.

## Verifying Prometheus is scraping guestbook metrics

```bash
kubectl port-forward svc/prometheus 9090:9090 -n monitoring
```

Open http://localhost:9090/targets. You should see:
- `kubernetes-cadvisor` -- one target per node, **State: UP**
- `kubernetes-pods` -- present but with no active targets, since the frontend's scrape annotation is off (see note above)

To confirm data is actually flowing, run this query in the Prometheus UI:

```
container_cpu_usage_seconds_total{namespace="guestbook"}
```

You should get one series per container in the guestbook namespace.

## Cleanup

```bash
pulumi destroy
```

## Notes

- Storage for both Prometheus and Grafana uses `emptyDir` -- data won't survive pod restarts. Fine for this exercise, but you'd want a PVC in production.
- Grafana admin password is hardcoded to `admin` for simplicity. In a real deployment this would come from a Pulumi secret / Kubernetes Secret instead of a plain env var.
- The cAdvisor scrape job filters to the `guestbook` namespace via `metric_relabel_configs`, so it doesn't pull in cadvisor metrics for every pod on the node.
- Two things worth flagging in case they come up: Grafana's dashboard queries need an explicit `datasource` UID on every panel and target when the dashboard is provisioned from a file -- without it, panels silently show "No data" even though the underlying Prometheus query works fine. And after `pulumi up` changes a ConfigMap, Grafana and Prometheus don't always pick up the new file right away -- `kubectl rollout restart deployment/<name> -n monitoring` forces it.
