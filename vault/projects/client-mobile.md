---
project: client-mobile
type: mobile-app
tags: [flutter, cognito, oauth]
---

# Client Mobile App (Flutter)

The mobile client application built with Flutter.

## Authentication Architecture
- Uses AWS Cognito User Pools with OAuth2 Authorization Code flow with PKCE.
- Test tokens generated via the AWS Cognito Identity Provider SDK mock client `getCognitoTestJwt()`.
