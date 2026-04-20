import { expect, test } from '@playwright/test';

/**
 * Smoke test: unauthenticated visitors should hit the Clerk sign-in gate
 * and the app shell should render without console errors from our own code.
 *
 * We don't assert on Clerk's internals — the key is that our React shell
 * mounted and the sign-in component is visible somewhere on the page.
 */

test('sign-in gate renders for signed-out users', async ({ page }) => {
  const ourErrors: string[] = [];
  page.on('pageerror', (err) => ourErrors.push(err.message));
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    // Ignore Clerk's placeholder-key dev warnings so local runs don't flake.
    if (text.includes('Clerk') || text.includes('publishableKey')) return;
    ourErrors.push(text);
  });

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Jarvis' })).toBeVisible();
  await expect(page.getByText(/AI-микрофон/i)).toBeVisible();
  expect(ourErrors).toEqual([]);
});
