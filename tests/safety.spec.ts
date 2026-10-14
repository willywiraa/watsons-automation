import { test, expect } from '@playwright/test';
import {
  checkStagingUrl,
  installNavigationGuard,
  isApprovedUrl,
  SafetyCheckError,
  STAGING_BACKOFFICE_HOST,
  STAGING_HOST,
  STAGING_LOGIN_HOST,
  STAGING_PAYMENT_HOST,
} from '../src/safety/staging-guard';

// Offline checks of the safety lock. Nothing here visits a real website: blocked page
// loads are cancelled before they leave the PC.
test.describe('safety lock: configured address', () => {
  test('accepts the approved staging address', () => {
    expect(checkStagingUrl(`https://${STAGING_HOST}/`).href).toBe(`https://${STAGING_HOST}/`);
    expect(checkStagingUrl(`https://${STAGING_HOST}`).href).toBe(`https://${STAGING_HOST}/`);
  });

  const refused = {
    'another website': 'https://www.example.com/',
    'the production slot of the same platform': `https://${STAGING_HOST.replace('-s1-', '-p1-')}/`,
    'a look-alike ending': `https://${STAGING_HOST}.example.com/`,
    'a look-alike beginning': `https://evil-${STAGING_HOST}/`,
    'plain http': `http://${STAGING_HOST}/`,
    'a different port': `https://${STAGING_HOST}:8443/`,
    'a login inside the address': `https://user:secret@${STAGING_HOST}/`,
    'something that is not an address': 'staging',
  };
  for (const [what, url] of Object.entries(refused)) {
    test(`refuses ${what}`, () => {
      expect(() => checkStagingUrl(url)).toThrow(SafetyCheckError);
    });
  }
});

test.describe('safety lock: sites the browser may open', () => {
  test('allows the staging site and its login service', () => {
    expect(isApprovedUrl(new URL(`https://${STAGING_HOST}/cart`))).toBe(true);
    expect(isApprovedUrl(new URL(`https://${STAGING_LOGIN_HOST}/authorizationserver/login`))).toBe(true);
  });

  test('allows only the TEST payment page, not the live one', () => {
    expect(isApprovedUrl(new URL(`https://${STAGING_PAYMENT_HOST}/pay`))).toBe(true);
    expect(isApprovedUrl(new URL('https://secureacceptance.cybersource.com/pay'))).toBe(false);
    expect(isApprovedUrl(new URL(`https://${STAGING_PAYMENT_HOST}.example.com/pay`))).toBe(false);
    expect(isApprovedUrl(new URL(`http://${STAGING_PAYMENT_HOST}/pay`))).toBe(false);
  });

  test('allows only the staging backoffice, not its production slot or look-alikes', () => {
    expect(isApprovedUrl(new URL(`https://${STAGING_BACKOFFICE_HOST}/backoffice/login.zul`))).toBe(true);
    expect(isApprovedUrl(new URL(`https://${STAGING_BACKOFFICE_HOST.replace('-s1-', '-p1-')}/backoffice/`))).toBe(false);
    expect(isApprovedUrl(new URL(`https://${STAGING_BACKOFFICE_HOST}.example.com/`))).toBe(false);
    expect(isApprovedUrl(new URL(`http://${STAGING_BACKOFFICE_HOST}/backoffice/`))).toBe(false);
    // The backoffice address is for the browser only; it is never a valid WATSONS_STAGING_URL.
    expect(() => checkStagingUrl(`https://${STAGING_BACKOFFICE_HOST}/`)).toThrow(SafetyCheckError);
  });

  test('refuses the production slot of the login service and look-alikes', () => {
    expect(isApprovedUrl(new URL(`https://${STAGING_LOGIN_HOST.replace('-s1-', '-p1-')}/`))).toBe(false);
    expect(isApprovedUrl(new URL(`https://${STAGING_LOGIN_HOST}.example.com/`))).toBe(false);
    expect(isApprovedUrl(new URL(`http://${STAGING_LOGIN_HOST}/`))).toBe(false);
    expect(isApprovedUrl(new URL('https://www.example.com/'))).toBe(false);
  });
});

test.describe('safety lock: browser', () => {
  test('stops the browser from opening a site that is not approved', async ({ context, page }) => {
    const guard = await installNavigationGuard(context, new Set(['approved.example']));

    await expect(page.goto('https://not-approved.example/')).rejects.toThrow();

    expect(guard.blocked).toEqual(['https://not-approved.example/']);
    expect(() => guard.throwIfViolated()).toThrow('SAFETY CHECK FAILED');
  });
});
