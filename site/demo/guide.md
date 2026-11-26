# Upgrade the workspace to Team

An example guide for a fictional billing screen\. The same guide supplies the human HTML and agent replay downloads\. No private data is included\.

App: Ledgerly \(fictional example\) · Captured: 2026\-11\-25T00:00:00Z · Verified: never\-run · Schema: stepdoc/guide@1 · Version: 1

## Preconditions

- Use the fictional example workspace with the Owner role\.

## Variables

No variables required.

## Steps

### 1. Go to app\.ledgerly\.io/settings

Page: <https://app.ledgerly.io/settings>

Action: navigate

![Fictional Ledgerly billing screen with sensitive fields already blurred\.](<img/ledgerly-billing.png>)

### 2. Click "Billing" in the sidebar

Page: <https://app.ledgerly.io/settings>

Target: link “Billing”

Action: click

Expected: URL matches /settings/billing

![Fictional Ledgerly billing screen with sensitive fields already blurred\.](<img/ledgerly-billing.png>)

### 3. Click "Change plan"

Opens the plan picker\. Only workspace owners see this button\.

Page: <https://app.ledgerly.io/settings/billing>

Target: button “Change plan”

Action: click

Expected: dialog Choose a plan is visible

![Fictional Ledgerly billing screen with sensitive fields already blurred\.](<img/ledgerly-billing.png>)
