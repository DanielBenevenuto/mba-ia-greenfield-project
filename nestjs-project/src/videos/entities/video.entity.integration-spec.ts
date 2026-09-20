import { randomUUID } from 'node:crypto';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { MAX_VIDEO_SIZE_BYTES, VideoStatus } from '../video.constants';
import { Video } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    const user = await userRepository.save(
      userRepository.create({
        email: `video_user_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `Channel ${counter}`,
        nickname: `video_chan_${counter}`,
        user_id: user.id,
      }),
    );
  }

  function buildVideo(
    channelId: string,
    overrides: Partial<Video> = {},
  ): Video {
    return videoRepository.create({
      public_id: `pub${String(++counter).padStart(8, '0')}`,
      channel_id: channelId,
      title: 'My Video',
      original_filename: 'my-video.mp4',
      content_type: 'video/mp4',
      size_bytes: 1024,
      storage_key: `videos/${randomUUID()}/source/my-video.mp4`,
      ...overrides,
    });
  }

  it('should default status to draft when not provided', async () => {
    const channel = await createChannel();

    const saved = await videoRepository.save(buildVideo(channel.id));
    const found = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(found.status).toBe(VideoStatus.DRAFT);
  });

  it('should enforce the unique constraint on public_id', async () => {
    const channel = await createChannel();
    const publicId = 'dupPublicI';

    await videoRepository.save(buildVideo(channel.id, { public_id: publicId }));

    await expect(
      videoRepository.save(buildVideo(channel.id, { public_id: publicId })),
    ).rejects.toThrow();
  });

  it('should enforce the foreign key to channels', async () => {
    await expect(
      videoRepository.save(buildVideo(randomUUID())),
    ).rejects.toThrow();
  });

  it('should store and return the 10 GiB ceiling without precision loss', async () => {
    const channel = await createChannel();

    const saved = await videoRepository.save(
      buildVideo(channel.id, { size_bytes: MAX_VIDEO_SIZE_BYTES }),
    );
    const found = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(found.size_bytes).toBe(MAX_VIDEO_SIZE_BYTES);
    expect(typeof found.size_bytes).toBe('number');
  });

  it('should leave the processing columns null until the worker fills them', async () => {
    const channel = await createChannel();

    const saved = await videoRepository.save(buildVideo(channel.id));
    const found = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(found.upload_id).toBeNull();
    expect(found.thumbnail_key).toBeNull();
    expect(found.duration_seconds).toBeNull();
    expect(found.metadata).toBeNull();
    expect(found.processing_error).toBeNull();
  });

  it('should round-trip duration_seconds and the metadata jsonb column', async () => {
    const channel = await createChannel();

    const saved = await videoRepository.save(
      buildVideo(channel.id, {
        status: VideoStatus.READY,
        duration_seconds: 12.345,
        metadata: {
          width: 1920,
          height: 1080,
          video_codec: 'h264',
          audio_codec: 'aac',
          bitrate: 4200000,
          format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
        },
      }),
    );
    const found = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(found.duration_seconds).toBeCloseTo(12.345, 3);
    expect(found.metadata).toEqual(
      expect.objectContaining({ width: 1920, video_codec: 'h264' }),
    );
  });

  it('should load the owning channel through the ManyToOne relation', async () => {
    const channel = await createChannel();
    const saved = await videoRepository.save(buildVideo(channel.id));

    const found = await videoRepository.findOne({
      where: { id: saved.id },
      relations: ['channel'],
    });

    expect(found?.channel.nickname).toBe(channel.nickname);
  });
});
