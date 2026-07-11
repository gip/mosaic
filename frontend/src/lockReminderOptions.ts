/** Allowed values for the backend-stored Mainnet lock reminder. 0 disables it. */

export const DEFAULT_LOCK_REMINDER_MINUTES = 3;

export const LOCK_REMINDER_OPTIONS: { minutes: number; label: string }[] = [
  { minutes: 1, label: '1 minute' },
  { minutes: 3, label: '3 minutes' },
  { minutes: 5, label: '5 minutes' },
  { minutes: 10, label: '10 minutes' },
  { minutes: 30, label: '30 minutes' },
  { minutes: 0, label: 'Disabled' },
];
