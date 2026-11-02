const dateTime = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeStyle: 'medium',
  timeZone: process.env.DISPLAY_TIMEZONE ?? 'Europe/Zurich',
});

export const formatDateTime = (value: string | null) => (value ? dateTime.format(new Date(value)) : 'Never');

export function formatRelative(value: string | null): string {
  if (!value) return 'Never';
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  const unit = (amount: number, name: string) => `${amount} ${name}${amount === 1 ? '' : 's'}`;
  const text =
    abs < 60 ? unit(abs, 'second') : abs < 3600 ? unit(Math.round(abs / 60), 'minute') : abs < 86400 ? unit(Math.round(abs / 3600), 'hour') : unit(Math.round(abs / 86400), 'day');
  return seconds <= 0 ? `${text} ago` : `in ${text}`;
}

export function formatInterval(minutes: number): string {
  if (minutes % 1440 === 0) return minutes === 1440 ? 'Every day' : `Every ${minutes / 1440} days`;
  if (minutes % 60 === 0) return minutes === 60 ? 'Every hour' : `Every ${minutes / 60} hours`;
  return minutes === 1 ? 'Every minute' : `Every ${minutes} minutes`;
}
