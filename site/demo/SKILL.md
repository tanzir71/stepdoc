---
name: upgrade-workspace-team
description: "An example guide for a fictional billing screen. The same guide supplies the human HTML and agent replay downloads. No private data is included."
---

# Upgrade the workspace to Team

## Purpose

An example guide for a fictional billing screen\. The same guide supplies the human HTML and agent replay downloads\. No private data is included\.

App: Ledgerly \(fictional example\) · Captured: 2026\-11\-25T00:00:00Z · Verified: never\-run · Schema: stepdoc/guide@1 · Version: 1

## Preconditions

- Use the fictional example workspace with the Owner role\.

## Variables

No variables required.

## Steps

1. Go to app\.ledgerly\.io/settings
   - Action: navigate
   - Target: No captured target
   - Page: <https://app.ledgerly.io/settings>
   - Expected: No captured assertion.

2. Click "Billing" in the sidebar
   - Action: click
   - Target: link “Billing”
   - Page: <https://app.ledgerly.io/settings>
   - Expected: URL matches /settings/billing

3. Click "Change plan"
   Opens the plan picker\. Only workspace owners see this button\.
   - Action: click
   - Target: button “Change plan”
   - Page: <https://app.ledgerly.io/settings/billing>
   - Expected: dialog Choose a plan is visible
