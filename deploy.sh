#!/bin/bash
set -e

# ── BillingCapture GitHub Pages Deploy Script ──
# Usage: ./deploy.sh YOUR_GITHUB_TOKEN

TOKEN=$1
USERNAME="takubug"
REPO="billing-capture"

if [ -z "$TOKEN" ]; then
  echo "❌  Usage: ./deploy.sh YOUR_GITHUB_TOKEN"
  exit 1
fi

echo "📦  Installing dependencies..."
npm install

echo "🔨  Building..."
npm run build

echo "🐙  Creating GitHub repository..."
curl -s -X POST https://api.github.com/user/repos \
  -H "Authorization: token $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"$REPO\",\"private\":false,\"description\":\"Patient billing capture PWA\"}" \
  | grep -q '"full_name"' && echo "✅  Repo created (or already exists)" || echo "⚠️  Repo may already exist, continuing..."

echo "🔧  Configuring git..."
git init
git config user.email "deploy@billingcapture"
git config user.name "BillingCapture Deploy"
git add .
git commit -m "Initial deploy" 2>/dev/null || echo "Nothing new to commit"
git branch -M main
git remote remove origin 2>/dev/null || true
git remote add origin "https://$USERNAME:$TOKEN@github.com/$USERNAME/$REPO.git"
git push -u origin main --force

echo "🚀  Deploying to GitHub Pages..."
npx gh-pages -d dist --dotfiles \
  -r "https://$USERNAME:$TOKEN@github.com/$USERNAME/$REPO.git"

echo ""
echo "✅  Done! Your app will be live in ~60 seconds at:"
echo "   https://$USERNAME.github.io/$REPO"
echo ""
echo "📱  To install on iPhone:"
echo "   1. Open the URL above in Safari"
echo "   2. Tap Share → Add to Home Screen"
