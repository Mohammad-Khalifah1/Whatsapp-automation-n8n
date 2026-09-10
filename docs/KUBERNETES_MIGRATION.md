# Kubernetes Migration

**Not built, and not recommended yet.** Kubernetes 1.36.1 is available and
healthy on the development machine, so this was a real option that was
deliberately not taken.

---

## Why Compose was chosen

The MVP is **one stateful service with one volume**. Kubernetes would add a
Deployment, Service, Ingress, ConfigMap, Secret, PVC and a controller to reason
about — and would change nothing about how the system behaves.

| | Docker Compose | Kubernetes |
|---|---|---|
| Files to understand | 1 | 7+ |
| Time to first run | Minutes | Hours |
| Fits a $6/month VPS | Yes | Barely |
| Rolling deploys | No | Yes |
| Self-healing | Restart policy only | Yes |
| Horizontal scaling | No | Yes |
| **Useful for this workload today** | **Yes** | **No** |

The production target is a single small VPS, where Compose is also the right
tool. Recorded as [D-001](DECISIONS.md#d-001--docker-compose-for-the-mvp-not-kubernetes).

---

## When Kubernetes becomes justified

Move when **at least two** of these are true:

| Trigger | Why Compose stops being enough |
|---|---|
| **Multiple n8n instances needed** | Requires queue mode, a shared DB, and coordinated rollout |
| **Zero-downtime deploys required** | Compose restarts drop in-flight webhooks |
| **Already running a cluster** | Consistency with existing operations is a real benefit |
| **Multiple environments to keep identical** | Manifests + Kustomize genuinely beat copied compose files |
| **A platform team operates it** | Kubernetes needs owners |

### An important prerequisite

**Do not scale n8n horizontally while Google Sheets is the store.** Multiple
instances break the concurrency-1 mitigation that currently prevents
double-assignment, and Sheets cannot provide locking to replace it.

The correct order is:

1. Migrate to PostgreSQL — [GOOGLE_SHEETS_TO_POSTGRES.md](GOOGLE_SHEETS_TO_POSTGRES.md)
2. Enable n8n queue mode (Redis + workers)
3. *Then* consider Kubernetes

Skipping to step 3 produces a beautifully orchestrated system that assigns two
customers to the same agent.

---

## Target architecture

```
                    Internet
                       │
                       v
              ┌────────────────┐
              │    Ingress     │  TLS via cert-manager
              │  (nginx/traefik)│
              └───────┬────────┘
                      │
              ┌───────v────────┐
              │  Service       │  ClusterIP
              │  n8n-main      │
              └───────┬────────┘
                      │
       ┌──────────────┴──────────────┐
       │                             │
┌──────v───────┐            ┌────────v────────┐
│ Deployment   │            │ Deployment      │
│ n8n-main     │            │ n8n-worker      │
│ (webhooks +  │            │ (executions)    │
│  editor)     │            │ replicas: 2+    │
└──────┬───────┘            └────────┬────────┘
       │                             │
       └──────────────┬──────────────┘
                      │
       ┌──────────────┼──────────────┐
       v              v              v
┌────────────┐ ┌────────────┐ ┌────────────┐
│ PostgreSQL │ │   Redis    │ │  Secrets   │
│ StatefulSet│ │ (queue)    │ │ ConfigMap  │
│ + PVC      │ │            │ │            │
└────────────┘ └────────────┘ └────────────┘
```

Note this is a **queue-mode** deployment. Running multiple `n8n-main` replicas
without queue mode duplicates schedule triggers and webhook registrations.

---

## Resource mapping

| Compose | Kubernetes | Notes |
|---|---|---|
| `services.n8n` | `Deployment` (main) + `Deployment` (workers) | Split roles |
| `ports: 5678` | `Service` (ClusterIP) + `Ingress` | Never `NodePort` in production |
| `environment` (non-secret) | `ConfigMap` | |
| `environment` (secrets) | `Secret`, ideally External Secrets | |
| `volumes: n8n_data` | `PersistentVolumeClaim` | Only for the main pod |
| `restart: unless-stopped` | Default `restartPolicy: Always` | |
| `healthcheck` | `livenessProbe` + `readinessProbe` | Split them — see below |
| Caddy | `Ingress` + `cert-manager` | |

---

## Manifest sketches

### ConfigMap and Secret

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: n8n-config
data:
  GENERIC_TIMEZONE: "Asia/Amman"
  TZ: "Asia/Amman"
  N8N_PROTOCOL: "https"
  N8N_HOST: "wa.example.com"
  N8N_WEBHOOK_URL: "https://wa.example.com/"
  META_GRAPH_API_VERSION: "v26.0"
  NODE_FUNCTION_ALLOW_BUILTIN: "crypto"
  N8N_BLOCK_ENV_ACCESS_IN_NODE: "false"
  N8N_UNVERIFIED_PACKAGES_ENABLED: "false"
  EXECUTIONS_MODE: "queue"
---
apiVersion: v1
kind: Secret
metadata:
  name: n8n-secrets
type: Opaque
stringData:
  N8N_ENCRYPTION_KEY: ""        # from a real secret manager, never committed
  META_ACCESS_TOKEN: ""
  META_APP_SECRET: ""
  WEBHOOK_VERIFY_TOKEN: ""
  DB_POSTGRESDB_PASSWORD: ""
```

> A `Secret` is **base64, not encryption**. Anyone with read access to the
> namespace can decode it. Use Sealed Secrets, External Secrets Operator, or a
> cloud secret manager — and enable encryption at rest for etcd.

### Deployment (main)

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: n8n-main
spec:
  replicas: 1                  # see the note on scaling main below
  strategy:
    type: Recreate             # RWO volume cannot be mounted by two pods
  selector:
    matchLabels: { app: n8n, role: main }
  template:
    metadata:
      labels: { app: n8n, role: main }
    spec:
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        fsGroup: 1000
      containers:
        - name: n8n
          image: docker.n8n.io/n8nio/n8n:2.38.5    # pinned, never :latest
          ports:
            - containerPort: 5678
          envFrom:
            - configMapRef: { name: n8n-config }
            - secretRef:    { name: n8n-secrets }
          volumeMounts:
            - name: data
              mountPath: /home/node/.n8n
          resources:
            requests: { memory: "512Mi", cpu: "250m" }
            limits:   { memory: "2Gi",   cpu: "1000m" }
          # Readiness gates traffic; liveness restarts. Keep them distinct so a
          # slow start does not cause a restart loop.
          readinessProbe:
            httpGet: { path: /healthz, port: 5678 }
            initialDelaySeconds: 15
            periodSeconds: 5
          livenessProbe:
            httpGet: { path: /healthz, port: 5678 }
            initialDelaySeconds: 60
            periodSeconds: 30
            failureThreshold: 3
      volumes:
        - name: data
          persistentVolumeClaim: { claimName: n8n-data }
```

### PVC, Service, Ingress

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: n8n-data
spec:
  accessModes: ["ReadWriteOnce"]
  resources:
    requests: { storage: 10Gi }
---
apiVersion: v1
kind: Service
metadata:
  name: n8n
spec:
  type: ClusterIP
  selector: { app: n8n, role: main }
  ports:
    - port: 80
      targetPort: 5678
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: n8n
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
    nginx.ingress.kubernetes.io/proxy-body-size: "10m"
spec:
  ingressClassName: nginx
  tls:
    - hosts: [wa.example.com]
      secretName: n8n-tls
  rules:
    - host: wa.example.com
      http:
        paths:
          # Only the Meta webhook path is public.
          - path: /webhook/whatsapp
            pathType: Prefix
            backend:
              service: { name: n8n, port: { number: 80 } }
```

Expose the editor and `/webhook/agent/*` through a **separate** Ingress
restricted by IP allowlist or authentication — the same principle as the Caddy
configuration in [DEPLOYMENT_HOSTINGER.md](DEPLOYMENT_HOSTINGER.md).

### NetworkPolicy

Worth adding early — it is one of the genuine wins of moving to Kubernetes:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: n8n-egress
spec:
  podSelector:
    matchLabels: { app: n8n }
  policyTypes: [Egress]
  egress:
    - to:                      # DNS
        - namespaceSelector: {}
      ports: [{ protocol: UDP, port: 53 }]
    - to:                      # Postgres and Redis in-cluster
        - podSelector:
            matchExpressions:
              - { key: app, operator: In, values: [postgres, redis] }
    - to: [{ ipBlock: { cidr: 0.0.0.0/0 } }]   # Meta + Google APIs
      ports: [{ protocol: TCP, port: 443 }]
```

---

## Things that bite

| Issue | Detail |
|---|---|
| **RWO volumes** | A `ReadWriteOnce` PVC cannot be mounted by two pods. Use `strategy: Recreate` for main, or move to RWX/object storage |
| **Do not scale `main`** | Multiple mains without queue mode duplicate schedule triggers and fight over webhook registration |
| **Encryption key must be identical** | Every pod needs the same `N8N_ENCRYPTION_KEY`, or credentials fail to decrypt |
| **Webhooks during rollout** | `Recreate` means downtime. Meta retries, and dedupe handles the replay — but plan the window |
| **Probe tuning** | n8n's first boot can exceed a tight `initialDelaySeconds`, producing a restart loop that looks like a crash |
| **Secrets are not encrypted** | Base64 only. Use a real secret manager |
| **Timezone** | Set `TZ` in the ConfigMap; pods default to UTC and schedule triggers will fire at the wrong local time |

---

## Migration steps

1. Migrate to PostgreSQL (prerequisite)
2. Enable queue mode with Redis, still on Compose — validate it there first
3. Write manifests; deploy to a staging namespace
4. Import workflows: `kubectl exec` the same
   `n8n import:workflow` command
5. Recreate credentials (they cannot be copied without the same encryption key
   and database)
6. Test the full webhook flow against staging with a Meta test number
7. Cut DNS over; keep the old deployment running until confirmed
8. Decommission

---

## Honest recommendation

For a system handling a few hundred conversations a day on one VPS, Kubernetes
is **the wrong tool**. It adds operational surface without solving any problem
this system currently has, and the constraint that actually limits throughput
today is Google Sheets' 60 reads/minute — which Kubernetes does nothing about.

Revisit when there is a concrete requirement — multiple instances, zero-downtime
deploys, or an existing cluster to fit into — and when PostgreSQL and queue mode
are already in place.
