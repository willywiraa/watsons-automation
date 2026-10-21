import { test, expect } from '@playwright/test';
import { ADD_DELAY_SECONDS, readSettings, SettingsError } from '../src/config/settings';

// Offline checks of the settings check itself, using made-up values.
// No browser and no website are involved.
test.describe('settings check', () => {
  const complete = {
    WATSONS_STAGING_URL: 'https://staging.example.test/',
    WATSONS_USERNAME: 'someone@example.test',
    WATSONS_PASSWORD: 'made-up-password',
    WATSONS_PAYMENT_OTP: '0000',
  };

  test('accepts a complete set of settings', () => {
    expect(readSettings(complete)).toEqual({
      stagingUrl: 'https://staging.example.test/',
      username: 'someone@example.test',
      password: 'made-up-password',
      paymentOtp: '0000',
      placeOrder: false,
      orderFile: undefined,
      approveOrder: undefined,
      backoffice: undefined,
      holdLastPage: false,
    });
  });

  test('waits a fixed 5 seconds between adds: no setting changes it (user\'s decision 2026-10-21)', () => {
    expect(ADD_DELAY_SECONDS).toBe(5);
    expect(readSettings({ ...complete, WATSONS_ADD_DELAY_SECONDS: '20' })).not.toHaveProperty('addDelaySeconds');
  });

  test('reads the existing order to approve, and then needs the backoffice account', () => {
    const backoffice = { WATSONS_BACKOFFICE_USERNAME: 'support@example.test', WATSONS_BACKOFFICE_PASSWORD: 'made-up-too' };
    expect(() => readSettings({ ...complete, WATSONS_APPROVE_ORDER: '07091012' })).toThrow(
      'Missing settings in .env: WATSONS_BACKOFFICE_USERNAME, WATSONS_BACKOFFICE_PASSWORD.',
    );
    for (const typed of ['07091012', 'WTCSG07091012', ' wtcsg 0709 1012 ']) {
      const settings = readSettings({ ...complete, ...backoffice, WATSONS_APPROVE_ORDER: typed });
      expect(settings.approveOrder, typed).toBe('07091012');
      expect(settings.placeOrder, typed).toBe(false);
    }
    for (const wrong of ['0709101', '070910123', 'WTCSG', 'ABC07091012', '0709-1012']) {
      expect(() => readSettings({ ...complete, ...backoffice, WATSONS_APPROVE_ORDER: wrong }), wrong).toThrow(
        'WATSONS_APPROVE_ORDER must be an order number',
      );
    }
    expect(readSettings({ ...complete, WATSONS_APPROVE_ORDER: ' ' }).approveOrder).toBeUndefined();
  });

  test('approving needs no shop account; placing an order does', () => {
    const backoffice = { WATSONS_BACKOFFICE_USERNAME: 'support@example.test', WATSONS_BACKOFFICE_PASSWORD: 'made-up-too' };
    const noShopAccount = { ...complete, ...backoffice, WATSONS_USERNAME: undefined, WATSONS_PASSWORD: undefined };
    expect(readSettings({ ...noShopAccount, WATSONS_APPROVE_ORDER: '07091012' })).toMatchObject({ approveOrder: '07091012', username: '', password: '' });
    expect(() => readSettings({ ...noShopAccount, WATSONS_PLACE_ORDER: 'yes' })).toThrow('Missing settings in .env: WATSONS_USERNAME, WATSONS_PASSWORD.');
    expect(() => readSettings(noShopAccount)).toThrow('Missing settings in .env: WATSONS_USERNAME, WATSONS_PASSWORD.');
  });

  test('needs the backoffice account only to approve; placing an order works without it', () => {
    const backoffice = { WATSONS_BACKOFFICE_USERNAME: 'support@example.test', WATSONS_BACKOFFICE_PASSWORD: 'made-up-too' };
    // Without it the order is placed and waits for approval (user's decision 2026-10-14).
    expect(readSettings({ ...complete, WATSONS_PLACE_ORDER: 'yes' })).toMatchObject({ placeOrder: true, backoffice: undefined });
    expect(readSettings({ ...complete, ...backoffice, WATSONS_PLACE_ORDER: 'yes' }).backoffice).toEqual({
      username: 'support@example.test',
      password: 'made-up-too',
    });
    expect(readSettings({ ...complete, WATSONS_BACKOFFICE_USERNAME: 'support@example.test' }).backoffice).toBeUndefined();
    expect(() => readSettings({ ...complete, WATSONS_APPROVE_ORDER: '07091012' })).toThrow(
      'Missing settings in .env: WATSONS_BACKOFFICE_USERNAME, WATSONS_BACKOFFICE_PASSWORD.',
    );
  });

  test('keeps the last page open only when asked to', () => {
    expect(readSettings(complete).holdLastPage).toBe(false);
    expect(readSettings({ ...complete, WATSONS_HOLD_LAST_PAGE: 'yes' }).holdLastPage).toBe(true);
    expect(readSettings({ ...complete, WATSONS_HOLD_LAST_PAGE: 'true' }).holdLastPage).toBe(false);
  });

  test('uses OTP 1234 unless one is set', () => {
    expect(readSettings({ ...complete, WATSONS_PAYMENT_OTP: undefined }).paymentOtp).toBe('1234');
    expect(readSettings({ ...complete, WATSONS_PAYMENT_OTP: ' ' }).paymentOtp).toBe('1234');
  });

  test('places orders only when the switch is exactly "yes"', () => {
    const backoffice = { WATSONS_BACKOFFICE_USERNAME: 'support@example.test', WATSONS_BACKOFFICE_PASSWORD: 'made-up-too' };
    expect(readSettings({ ...complete, ...backoffice, WATSONS_PLACE_ORDER: 'yes' }).placeOrder).toBe(true);
    expect(readSettings({ ...complete, ...backoffice, WATSONS_PLACE_ORDER: 'YES ' }).placeOrder).toBe(true);
    expect(readSettings({ ...complete, WATSONS_PLACE_ORDER: 'true' }).placeOrder).toBe(false);
    expect(readSettings({ ...complete, WATSONS_PLACE_ORDER: '1' }).placeOrder).toBe(false);
    expect(readSettings(complete).placeOrder).toBe(false);
  });

  test('names every missing or blank setting', () => {
    const env = { ...complete, WATSONS_USERNAME: undefined, WATSONS_PASSWORD: '   ' };
    expect(() => readSettings(env)).toThrow(
      'Missing settings in .env: WATSONS_USERNAME, WATSONS_PASSWORD.',
    );
  });

  test('never shows setting values in its message', () => {
    const env = { ...complete, WATSONS_USERNAME: '' };
    let message = '';
    try {
      readSettings(env);
    } catch (error) {
      expect(error).toBeInstanceOf(SettingsError);
      message = (error as Error).message;
    }
    expect(message).toContain('WATSONS_USERNAME');
    for (const value of Object.values(complete)) {
      expect(message).not.toContain(value);
    }
  });
});

// Checks YOUR .env file (loaded by playwright.config.ts). If this fails, the message
// names the missing settings, never their values.
test('your .env file has every required setting', () => {
  readSettings();
});
