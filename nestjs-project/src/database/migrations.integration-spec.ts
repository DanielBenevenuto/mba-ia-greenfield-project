import { DataSource } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Video } from '../videos/entities/video.entity';
import { CreateUsersAndChannels1775687773260 } from './migrations/1775687773260-CreateUsersAndChannels';
import { CreateAuthTokens1777579850478 } from './migrations/1777579850478-CreateAuthTokens';
import { CreateVideos1789927957459 } from './migrations/1789927957459-CreateVideos';
import { createTestDataSource } from '../test/create-test-data-source';

const MANAGED_TABLES = [
  'videos',
  'refresh_tokens',
  'verification_tokens',
  'channels',
  'users',
];

/**
 * Enum types are created by migrations but are NOT removed by
 * `DROP TABLE ... CASCADE`. Leaving them behind makes the next `runMigrations()`
 * fail with `type "..." already exists`, which is why this teardown drops them
 * explicitly — without it the suite only passes against a pristine schema.
 */
const MANAGED_ENUM_TYPES = [
  'videos_status_enum',
  'verification_tokens_type_enum',
];

describe('Database migrations (integration)', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = createTestDataSource(
      [User, Channel, RefreshToken, VerificationToken, Video],
      {
        synchronize: false,
        migrations: [
          CreateUsersAndChannels1775687773260,
          CreateAuthTokens1777579850478,
          CreateVideos1789927957459,
        ],
      },
    );

    await dataSource.initialize();

    // Ordered, not parallel: `videos` references `channels`, which references
    // `users`. CASCADE covers it either way, but dropping in dependency order
    // keeps the intent readable.
    for (const table of MANAGED_TABLES) {
      await dataSource.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
    }
    await dataSource.query(`DROP TABLE IF EXISTS "migrations" CASCADE`);
    for (const enumType of MANAGED_ENUM_TYPES) {
      await dataSource.query(`DROP TYPE IF EXISTS "public"."${enumType}"`);
    }
  });

  afterAll(async () => {
    // The second test undoes the last migration, leaving the videos table
    // missing. Re-apply so the shared DB is fully migrated for later suites.
    await dataSource.runMigrations();
    await dataSource.destroy();
  });

  it('should apply all migrations and create every managed table', async () => {
    const ranMigrations = await dataSource.runMigrations();

    expect(ranMigrations).toHaveLength(3);

    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      [MANAGED_TABLES],
    );
    const tableNames = result.map((r) => r.table_name);
    expect(tableNames).toEqual([
      'channels',
      'refresh_tokens',
      'users',
      'verification_tokens',
      'videos',
    ]);
  });

  it('should revert the last migration, removing the videos table and its enum type', async () => {
    await dataSource.undoLastMigration();

    const tables = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'videos'`,
    );
    expect(tables).toHaveLength(0);

    const types = await dataSource.query<{ typname: string }[]>(
      `SELECT typname FROM pg_type WHERE typname = 'videos_status_enum'`,
    );
    expect(types).toHaveLength(0);
  });
});
