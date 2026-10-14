import type { BrowserContext, Page } from '@playwright/test';

// The only website this project may open: the Watsons STAGING site (SAP Commerce Cloud,
// "s1" = staging). Changing this is a deliberate, reviewed code change.
// Never put a production address here.
export const STAGING_HOST = 'wtcsg.cmb8j9fjhz-apj3aswat1-s1-public.model-t.cc.commerce.ondemand.com';

// The staging site's login service (same environment, "s1"). Logging in sends the browser
// there and back. Approved by the user on 2026-10-04.
export const STAGING_LOGIN_HOST =
  'wtcsg-api.cmb8j9fjhz-apj3aswat1-s1-public.model-t.cc.commerce.ondemand.com';

// The payment page "Checkout" leads to: CyberSource Secure Acceptance, TEST environment (the
// live one is secureacceptance.cybersource.com, which stays blocked). Approved by the user on
// 2026-10-05.
export const STAGING_PAYMENT_HOST = 'testsecureacceptance.cybersource.com';

// The staging backoffice (same environment, "s1"), where the Customer Support role approves
// ("validates") new orders. Approved by the user on 2026-10-06.
export const STAGING_BACKOFFICE_HOST =
  'backoffice.cmb8j9fjhz-apj3aswat1-s1-public.model-t.cc.commerce.ondemand.com';

// Sites the browser's main window may show. Other addresses are added here only after they
// have been inspected and the user has approved them.
export const APPROVED_HOSTS: ReadonlySet<string> = new Set([
  STAGING_HOST,
  STAGING_LOGIN_HOST,
  STAGING_PAYMENT_HOST,
  STAGING_BACKOFFICE_HOST,
]);

/** True if the browser's main window may show this address. */
export function isApprovedUrl(url: URL, approvedHosts: ReadonlySet<string> = APPROVED_HOSTS): boolean {
  return url.protocol === 'https:' && approvedHosts.has(url.host);
}

export class SafetyCheckError extends Error {
  name = 'SafetyCheckError';
}

function safetyMessage(reason: string, details: string): string {
  return ['❌ SAFETY CHECK FAILED', '', reason, '', details, '', 'Order execution has been blocked.'].join('\n');
}

/**
 * Returns the configured address if it is the approved staging site.
 * Anything else (production, look-alikes, plain http, other ports) throws SafetyCheckError.
 */
export function checkStagingUrl(configured: string): URL {
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new SafetyCheckError(
      safetyMessage(
        'The configured URL is not an approved staging environment.',
        'WATSONS_STAGING_URL in .env is not a valid web address.',
      ),
    );
  }

  const approved =
    url.protocol === 'https:' && url.host === STAGING_HOST && !url.username && !url.password;
  if (!approved) {
    throw new SafetyCheckError(
      safetyMessage(
        'The configured URL is not an approved staging environment.',
        `Configured: ${url.protocol}//${url.host}\nApproved:   https://${STAGING_HOST}`,
      ),
    );
  }
  return new URL(url.origin);
}

/**
 * Stops every page in the browser context from opening a site that isn't approved.
 * A blocked page load is cancelled before it leaves the PC, and recorded; call
 * throwIfViolated() at the end of the test so the test fails if anything was blocked.
 */
export async function installNavigationGuard(
  context: BrowserContext,
  approvedHosts: ReadonlySet<string> = APPROVED_HOSTS,
) {
  const blocked: string[] = [];
  const isApproved = (url: URL) => isApprovedUrl(url, approvedHosts);

  // Cancel any main-window page load to an unapproved site. Other requests made by
  // approved pages (images, scripts, fonts) are left alone.
  await context.route(
    (url) => !isApproved(url),
    async (route) => {
      const request = route.request();
      if (request.isNavigationRequest() && request.frame().parentFrame() === null) {
        blocked.push(request.url());
        await route.abort('blockedbyclient');
      } else {
        await route.continue();
      }
    },
  );

  // Backstop: record any main window that still ends up on an unapproved website.
  // (Browser-internal pages such as about:blank or error pages are not websites.)
  const watch = (page: Page) =>
    page.on('framenavigated', (frame) => {
      const url = frame.url();
      const isWebsite = url.startsWith('https://') || url.startsWith('http://');
      if (frame === page.mainFrame() && isWebsite && !isApproved(new URL(url))) {
        blocked.push(url);
      }
    });
  context.pages().forEach(watch);
  context.on('page', watch);

  return {
    blocked,
    throwIfViolated() {
      if (blocked.length > 0) {
        throw new SafetyCheckError(
          safetyMessage(
            'The browser tried to open a site that is not approved, and was stopped.',
            `Blocked: ${[...new Set(blocked)].join('\n         ')}`,
          ),
        );
      }
    },
  };
}
