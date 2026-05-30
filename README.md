# Metropolis Infrastructure — Deployment Guide

This CDK stack deploys the full Metropolis metrics pipeline on AWS: VictoriaMetrics cluster, Grafana, vmagent, Vector, smart-metrics, and RDS Postgres — all behind an HTTPS Application Load Balancer with Cognito OIDC authentication.

---

## Prerequisites

Before deploying, make sure you have the following installed and configured on your machine.

### 1. Node.js and npm

Download and install Node.js (version 18 or higher) from https://nodejs.org. npm is included with Node.js.

Verify the installation:
```bash
node --version
npm --version
```

### 2. AWS CLI

The AWS CLI lets your machine communicate with your AWS account.

Install it by following the guide for your operating system:
https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html

Once installed, configure it with your AWS credentials:
```bash
aws configure
```

You will be prompted for:
- **AWS Access Key ID** — found in the AWS Console under IAM → Users → your user → Security credentials
- **AWS Secret Access Key** — generated at the same time as the Access Key ID
- **Default region name** — the AWS region you want to deploy to, e.g. `eu-west-1` for Ireland or `us-east-1` for US East
- **Default output format** — enter `json`

### 3. AWS CDK

```bash
npm install -g aws-cdk
```

Verify:
```bash
cdk --version
```

### 4. A domain name

You need a domain name (or subdomain) to point at the load balancer. For example: `grafana.yourdomain.com`. This is required for HTTPS and for the Cognito login page to redirect back correctly after authentication.

---

## Step 1 — Create an ACM Certificate

AWS Certificate Manager (ACM) provides free HTTPS certificates for domains you own. The certificate must be created in the **same AWS region** you are deploying to.

1. Go to the **AWS Console** → search for **Certificate Manager** → open it
2. Click **Request a certificate**
3. Choose **Request a public certificate** and click Next
4. Under **Fully qualified domain name**, enter the subdomain you plan to use, e.g. `grafana.yourdomain.com`
5. Under **Validation method**, choose **DNS validation**
6. Click **Request**

You will be taken to the certificate detail page. Its status will be **Pending validation**.

7. Click into the certificate. Under **Domains**, you will see a **CNAME name** and a **CNAME value**
8. Log in to your domain registrar and add a new **CNAME record** with those exact values. The process varies by registrar but all registrars support CNAME records — look for a "DNS management" or "DNS records" section
9. Return to ACM and wait. Validation typically takes 5–30 minutes. Refresh the page until the status shows **Issued**
10. Once issued, copy the **Certificate ARN** — it looks like `arn:aws:acm:eu-west-1:123456789012:certificate/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`. You will need this in Step 3

---

## Step 2 — Bootstrap CDK (first time only)

CDK needs to provision some resources in your AWS account before it can deploy stacks. This is a one-time setup per account and region:

```bash
cdk bootstrap aws://YOUR_ACCOUNT_ID/YOUR_REGION
```

Replace `YOUR_ACCOUNT_ID` with your 12-digit AWS account ID (found top-right in the AWS Console) and `YOUR_REGION` with your chosen region, e.g.:

```bash
cdk bootstrap aws://123456789012/eu-west-1
```

---

## Step 3 — Install dependencies and deploy

From the `infrastructure/` directory:

```bash
npm install
```

Then deploy, supplying the three required parameters:

```bash
npx cdk deploy --all \
  --parameters ApplicationStack:CertificateArn=YOUR_CERTIFICATE_ARN \
  --parameters ApplicationStack:DomainName=YOUR_DOMAIN \
  --parameters ApplicationStack:VmagentAuthPassword=YOUR_CHOSEN_PASSWORD
```

For example:
```bash
npx cdk deploy --all \
  --parameters ApplicationStack:CertificateArn=arn:aws:acm:eu-west-1:123456789012:certificate/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx \
  --parameters ApplicationStack:DomainName=grafana.yourdomain.com \
  --parameters ApplicationStack:VmagentAuthPassword=a-strong-password-here
```

`VmagentAuthPassword` is the password that any system pushing metrics to the pipeline must supply. Choose something strong — a random string of at least 20 characters is recommended. You will need to share this password with whoever configures the metric senders (see the Sending Metrics section below).

CDK will show you a summary of the changes and ask for confirmation before creating any resources. Type `y` to proceed.

Deployment takes approximately 10–15 minutes.

---

## Step 4 — Point your DNS at the load balancer

Once deployment completes, CDK prints the stack outputs. Look for `AlbDnsName` — it will look something like:

```
Outputs:
ApplicationStack.AlbDnsName = Metropolis-ALB-1234567890.eu-west-1.elb.amazonaws.com
```

Go back to your domain registrar's DNS management page and add a **CNAME record**:

| Name | Type | Value |
|---|---|---|
| `grafana` (or whatever subdomain you chose) | CNAME | the ALB DNS name from above |

DNS propagation usually takes a few minutes but can take up to an hour depending on your registrar.

---

## Step 5 — Create your first user

The Cognito User Pool is configured with self-signup disabled — users must be created by an administrator.

1. Go to the **AWS Console** → search for **Cognito** → open it
2. Click on **User pools** and select the pool named `UserPool` (inside the `ApplicationStack`)
3. Click **Create user**
4. Enter the user's email address. Leave **Send an invitation** checked
5. Click **Create user**

The user will receive an email from AWS Cognito with a temporary password.

---

## Step 6 — First login

1. Visit your domain in a browser, e.g. `https://grafana.yourdomain.com`
2. The load balancer redirects you to the Cognito hosted login page
3. Enter the email address and the temporary password from the invitation email
4. Cognito will prompt you to set a new permanent password
5. After setting the password you are redirected back to Grafana and signed in automatically — no second login prompt

All future visits will use the session cookie set by the load balancer. The session lasts 7 days before requiring re-authentication.

---

## Sending metrics

Metrics are pushed to vmagent over HTTPS on port 8429. The endpoint requires HTTP basic authentication using the `VmagentAuthPassword` you supplied at deploy time. The username is always `metrics`.

### Prometheus / vmagent remote_write

Add the following to your Prometheus or vmagent configuration, replacing the placeholders with your values:

```yaml
remote_write:
  - url: https://YOUR_DOMAIN:8429/api/v1/write
    basic_auth:
      username: metrics
      password: YOUR_VMAGENT_AUTH_PASSWORD
```

### Other senders

Any tool that supports Prometheus remote write (e.g. Grafana Agent, OpenTelemetry Collector) follows the same pattern — set the remote write URL to `https://YOUR_DOMAIN:8429/api/v1/write` and supply the username `metrics` and your chosen password in the basic auth fields.

If you need to rotate the password in future, redeploy the stack with a new `VmagentAuthPassword` value and update the configuration of all metric senders.
