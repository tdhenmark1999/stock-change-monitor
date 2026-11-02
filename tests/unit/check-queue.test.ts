import { describe, expect, it } from 'vitest';
import { redisConnection } from '../../apps/api/src/queue/check-queue';

describe('redisConnection', () => {
  it('uses database 0 when the URL names none', () => {
    expect(redisConnection('redis://localhost:6379')).toMatchObject({ host: 'localhost', port: 6379, db: 0 });
  });

  it('uses the database number from the URL', () => {
    expect(redisConnection('redis://127.0.0.1:6380/7')).toMatchObject({ host: '127.0.0.1', port: 6380, db: 7 });
  });
});
