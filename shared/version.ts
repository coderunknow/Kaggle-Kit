/**
 * Version metadata of the application.
 *
 * The release process requires three values to agree: the tag, the `version`
 * of `package.json` and the constant below. `shared/version.test.ts` fails as
 * soon as they drift apart, so a release cannot be built from sources that
 * still advertise an older version.
 */

export const APP_VERSION = '0.1.0-dev6';

/** User agent sent to the configured model server. Never contains a secret. */
export const APP_USER_AGENT = `Kaggle-Kit/${APP_VERSION}`;
