
This CDK stack deploys the Trickl metrics pipeline on AWS. It builds up a VictoriaMetrics cluster, Grafana, vmagent, Vector, smart-metrics, and RDS Postgres — all sat behind an HTTPS Application Load Balancer. Grafana login goes through Cognito OIDC; inbound metrics are gated by a WAF API key.

The best way to install this is to use Trickl's dedicated CLI tool, which will abstract much of this away for you, though you'll still need to login to AWS CLI beforehand, as well as have your ACM certificate for your domain.
---

## Prerequisites

You'll need a few things installed before you can deploy.

### 1. Node.js and npm

Install Node.js 18+ from https://nodejs.org — npm comes with it.

```bash
node --version
npm --version
```

### 2. AWS CLI

The CLI lets your machine talk to your AWS account.

Follow the install guide for your OS: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html

Then configure it:
```bash
aws configure
```

You'll be asked for:
- **AWS Access Key ID** — find it in the AWS Console under IAM → Users → your user → Security credentials
- **AWS Secret Access Key** — generated alongside the Access Key ID
- **Default region name** — e.g. `eu-west-1` for Ireland or `us-east-1` for US East
- **Default output format** — `json`

### 3. AWS CDK

```bash
npm install -g aws-cdk
cdk --version
```

### 4. A domain name

You need a domain or subdomain to point at the load balancer — e.g. `grafana.yourdomain.com`. This is required for HTTPS and for the Cognito login page to redirect back correctly after authentication.

---

## Step 1 — Create an ACM Certificate

ACM gives you free HTTPS certificates for domains you own. Create the certificate in the **same region** you're deploying to.

1. Go to the AWS Console → search for **Certificate Manager** → open it
2. Click **Request a certificate**
3. Choose **Request a public certificate** → Next
4. Enter your subdomain under **Fully qualified domain name**, e.g. `grafana.yourdomain.com`
5. Pick **DNS validation** → **Request**

The certificate will land in **Pending validation**.

6. Click into the certificate. Under **Domains** you'll see a **CNAME name** and **CNAME value**
7. Log into your domain registrar and add a CNAME record with those exact values — look for "DNS management" or "DNS records" in your registrar's control panel
8. Come back to ACM and wait. Validation usually takes 5–30 minutes. Refresh until the status shows **Issued**
9. Copy the **Certificate ARN** (looks like `arn:aws:acm:eu-west-1:123456789012:certificate/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`) — you'll need it in Step 3

---

## Step 2 — Bootstrap CDK (first time only)

CDK needs to set up some resources in your account before it can deploy anything. This is a one-off per account and region:

```bash
cdk bootstrap aws://YOUR_ACCOUNT_ID/YOUR_REGION
```

Your account ID is the 12-digit number in the top-right of the AWS Console. For example:

```bash
cdk bootstrap aws://123456789012/eu-west-1
```

---

## Step 3 — Install dependencies and deploy

From the `infrastructure/` directory:

```bash
npm install
```

Then deploy with the three required parameters:

```bash
npx cdk deploy --all \
  --parameters ApplicationStack:CertificateArn=YOUR_CERTIFICATE_ARN \
  --parameters ApplicationStack:DomainName=YOUR_DOMAIN \
  --parameters ApplicationStack:OpenAiApiKey=YOUR_OPENAI_API_KEY
```

For example:
```bash
npx cdk deploy --all \
  --parameters ApplicationStack:CertificateArn=arn:aws:acm:eu-west-1:123456789012:certificate/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx \
  --parameters ApplicationStack:DomainName=grafana.yourdomain.com \
  --parameters ApplicationStack:OpenAiApiKey=sk-your-openai-api-key
```

`OpenAiApiKey` is only used by the smart-metrics backend for the AI Investigator. CDK stores it in Secrets Manager and injects it into the ECS task as `OPENAI_API_KEY` — it never touches Grafana or the browser.

The metrics ingestion API key (`MetricsApiKey`) is auto-generated on first deploy and stored in Secrets Manager. After deployment, retrieve it from the ARN printed in the `MetricsApiKeySecretArn` stack output (see Sending Metrics below).

CDK will show you a summary of changes before doing anything — type `y` to proceed. The whole deployment takes around 10–15 minutes.

---

## Step 4 — Point your DNS at the load balancer

Once deployment finishes, check the CDK output for `AlbDnsName`:

```
Outputs:
ApplicationStack.AlbDnsName = Trickl-ALB-1234567890.eu-west-1.elb.amazonaws.com
```

Head back to your registrar's DNS management page and add a CNAME.
DNS usually propagates within a few minutes, but can take up to an hour.

---

## Step 5 — Create your first user

Self-signup is disabled on the Cognito User Pool, so users need to be created manually.

1. Go to the AWS Console → search for **Cognito** → open it
2. Click **User pools** and select `UserPool` (inside `ApplicationStack`)
3. Click **Create user**
4. Enter the user's email. Leave **Send an invitation** checked
5. Click **Create user**

AWS Cognito will send them an email with a temporary password.

---

## Step 6 — First login

1. Visit your domain, e.g. `https://grafana.yourdomain.com`
2. The load balancer redirects you to the Cognito hosted login page
3. Enter the email and temporary password from the invitation
4. Cognito will ask you to set a permanent password
5. After that you're dropped straight into Grafana — no second login

Sessions last 7 days before you'll need to re-authenticate.

---

## Sending metrics

Push metrics to Vector over HTTPS on port 9090 using OTLP/HTTP. Every request needs an `X-API-Key` header set to the auto-generated metrics API key.

**Endpoint:** `https://YOUR_DOMAIN:9090/v1/metrics`

### Retrieving the API key

The `MetricsApiKeySecretArn` stack output has the Secrets Manager ARN. Pull the value via CLI:

```bash
aws secretsmanager get-secret-value \
  --secret-id YOUR_SECRET_ARN \
  --query SecretString \
  --output text
```

Or go to **AWS Console → Secrets Manager**, find the secret by ARN, and click **Retrieve secret value**.

### Rotating the API key

1. Go to **AWS Console -> Secrets Manager** -> open the secret at `MetricsApiKeySecretArn`
2. Click **Retrieve secret value** -> **Edit** -> enter the new key -> **Save**
3. Redeploy to push the new value into the WAF rule:
   ```bash
   npx cdk deploy ApplicationStack
   ```
   CDK re-resolves the secret automatically — no parameters needed.
4. Update the key wherever you're sending metrics from.

### OpenTelemetry SDK (Node.js)

```javascript
const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-http');

const exporter = new OTLPMetricExporter({
  url: 'https://YOUR_DOMAIN:9090/v1/metrics',
  headers: {
    'X-API-Key': 'YOUR_METRICS_API_KEY',
  },
});
```

### Other OTLP senders

Any tool that speaks OTLP/HTTP works the same way — set the endpoint to `https://YOUR_DOMAIN:9090/v1/metrics` and add `X-API-Key: YOUR_METRICS_API_KEY` as a custom header. This includes OpenTelemetry Collector, Grafana Alloy, and others.
