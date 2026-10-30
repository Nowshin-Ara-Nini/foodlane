# Changelog

Foodlane release history. User-facing changes are listed here; deployment configuration and secret values are intentionally excluded.

## [0.1.0] - 2026-10-31

First public release of Foodlane, a neighborhood food discovery platform.

### Added

- Browse food listings and search by dish, seller, neighborhood, city, or district.
- View seller serving locations with Google Maps and open directions.
- Sign in with Google and choose a buyer or seller role.
- Submit seller identity and selling-place information for administrator review.
- Publish and manage food listings after approval.
- Mark interest on individual dishes, write dish-specific reviews, and recommend sellers separately.
- Administrator workflows for seller review, account moderation, suspension, deletion, and audit history.

### Privacy and security

- Store private seller verification evidence separately from public media.
- Require fresh MFA for sensitive administrator review and record evidence access in the audit log.
- Remove NID numbers and other verification-only details from active records after a review decision; queue private evidence for deletion.
- Respect seller approval and consent rules for public locations and photos.

### Scope

- Foodlane supports food discovery and seller feedback. It does not process orders, payments, or delivery.
- Seller verification reviews submitted identity and selling-place details; it is not a food-safety certification.
- See [README.md](README.md) for setup, architecture, deployment, and operational guidance.
