# BillingCapture

A mobile-first PWA for capturing patient billing information from label photos.

## Deploy to GitHub Pages

```bash
./deploy.sh YOUR_GITHUB_TOKEN
```

Your app will be live at: https://takubug.github.io/billing-capture

## Install on iPhone

1. Open https://takubug.github.io/billing-capture in Safari
2. Tap Share → Add to Home Screen

## Google Setup

1. Go to https://console.cloud.google.com
2. Create a new project
3. Enable Google Sheets API and Gmail API
4. OAuth consent screen → External → add your Gmail as test user
5. Credentials → OAuth 2.0 Client ID → Web application
6. Add `https://takubug.github.io/billing-capture/` as Authorised redirect URI
7. Paste Client ID into the app's Settings tab
