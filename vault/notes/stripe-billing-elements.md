---
tags: [billing, stripe, payments]
---

# Stripe Billing Elements Integration

- Subscriptions handled via Stripe Checkout Sessions.
- Webhook events handled: `checkout.session.completed`, `invoice.payment_succeeded`, `customer.subscription.deleted`.
- Grace period: 3 days past due before downgrading account capabilities.
