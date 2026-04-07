#!/bin/bash
# deploy-dashboard.sh — inject latest index.html into k8s ConfigMap and restart pod
set -e

KUBECONFIG="${KUBECONFIG:-$HOME/.kube/config-k3s-esxi}"
export KUBECONFIG

HTML_FILE="$(dirname "$0")/../dashboard/index.html"
NAMESPACE="monitoring"
CONFIGMAP="dashboard-html"
DEPLOYMENT="power-dashboard"

if [ ! -f "$HTML_FILE" ]; then
  echo "❌ index.html not found at $HTML_FILE"
  exit 1
fi

echo "📦 Updating ConfigMap $CONFIGMAP in namespace $NAMESPACE..."
kubectl create configmap "$CONFIGMAP" \
  --from-file=index.html="$HTML_FILE" \
  --namespace="$NAMESPACE" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "🔄 Restarting deployment $DEPLOYMENT..."
kubectl rollout restart deployment/"$DEPLOYMENT" -n "$NAMESPACE"

echo "⏳ Waiting for rollout..."
kubectl rollout status deployment/"$DEPLOYMENT" -n "$NAMESPACE" --timeout=60s

echo "✅ Dashboard deployed!"
kubectl get pods -n "$NAMESPACE" -l app="$DEPLOYMENT"
