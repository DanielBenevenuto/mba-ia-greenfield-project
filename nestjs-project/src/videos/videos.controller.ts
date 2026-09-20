import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import type { JwtPayload } from '../auth/auth.types';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateUploadDto } from './dto/create-upload.dto';
import type {
  CompleteUploadResult,
  PublicVideoView,
  StartUploadResult,
} from './videos.service';
import { VideosService } from './videos.service';

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post('uploads')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Start a video upload',
    description:
      'Pre-registers the video as a draft and opens a multipart upload session, returning one presigned URL per part. The file is uploaded directly to object storage — it never passes through this API.',
  })
  @ApiResponse({
    status: 201,
    description: 'Draft created and upload session opened',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        public_id: { type: 'string' },
        title: { type: 'string' },
        status: { type: 'string', example: 'draft' },
        upload: {
          type: 'object',
          properties: {
            upload_id: { type: 'string' },
            part_size_bytes: { type: 'integer' },
            total_parts: { type: 'integer' },
            expires_in_seconds: { type: 'integer' },
            parts: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  part_number: { type: 'integer' },
                  url: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'No channel is associated with this user',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 413,
    description: 'Video exceeds the maximum allowed size of 10 GiB',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 415,
    description: 'Content type is not a supported video format',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async startUpload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateUploadDto,
  ): Promise<StartUploadResult> {
    return this.videosService.startUpload(user.sub, dto);
  }

  @Post(':id/uploads/:uploadId/complete')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Complete a video upload',
    description:
      'Closes the multipart session with the ETags collected by the client, moves the video to processing and enqueues the background processing job.',
  })
  @ApiResponse({
    status: 200,
    description: 'Upload completed and processing enqueued',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        public_id: { type: 'string' },
        status: { type: 'string', example: 'processing' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'Video belongs to another channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'No open upload session for this video',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('uploadId') uploadId: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<CompleteUploadResult> {
    return this.videosService.completeUpload(user.sub, id, uploadId, dto.parts);
  }

  @Delete(':id/uploads/:uploadId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Abort a video upload',
    description:
      'Aborts the multipart session in storage and discards the draft video.',
  })
  @ApiResponse({ status: 204, description: 'Upload aborted and draft removed' })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'Video belongs to another channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'No open upload session for this video',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async abortUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('uploadId') uploadId: string,
  ): Promise<void> {
    return this.videosService.abortUpload(user.sub, id, uploadId);
  }

  @Public()
  @UseGuards(OptionalJwtAuthGuard)
  @Get(':publicId')
  @ApiOperation({
    summary: 'Get a video by its public URL identifier',
    description:
      'Returns the public metadata of a ready video. A video that is not ready is only visible to its owning channel; to anyone else it is indistinguishable from a video that does not exist.',
  })
  @ApiResponse({
    status: 200,
    description: 'Video metadata',
    schema: {
      properties: {
        public_id: { type: 'string' },
        title: { type: 'string' },
        status: { type: 'string', example: 'ready' },
        duration_seconds: { type: 'number', nullable: true },
        thumbnail_url: { type: 'string', nullable: true },
        metadata: { type: 'object', nullable: true },
        channel: {
          type: 'object',
          properties: {
            nickname: { type: 'string' },
            name: { type: 'string' },
          },
        },
        created_at: { type: 'string', format: 'date-time' },
      },
    },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async findOne(
    @Param('publicId') publicId: string,
    @CurrentUser() user?: JwtPayload,
  ): Promise<PublicVideoView> {
    return this.videosService.getPublicVideo(publicId, user?.sub);
  }

  @Public()
  @UseGuards(OptionalJwtAuthGuard)
  @Get(':publicId/stream')
  @ApiOperation({
    summary: 'Stream a video',
    description:
      'Serves the video with HTTP range support. With a Range header the response is 206 Partial Content carrying only the requested bytes, so playback starts without downloading the whole file.',
  })
  @ApiResponse({
    status: 200,
    description: 'Full video stream (no Range sent)',
  })
  @ApiResponse({
    status: 206,
    description: 'Partial content for the requested byte range',
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready for playback yet',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 416,
    description: 'Requested range is malformed or unsatisfiable',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async stream(
    @Param('publicId') publicId: string,
    @Headers('range') range: string | undefined,
    @Res() res: Response,
    @CurrentUser() user?: JwtPayload,
  ): Promise<void> {
    const target = await this.videosService.openStream(
      publicId,
      range,
      user?.sub,
    );

    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', target.contentType);
    res.setHeader('Content-Length', String(target.contentLength));
    if (target.contentRange) {
      res.setHeader('Content-Range', target.contentRange);
    }
    res.status(target.isPartial ? HttpStatus.PARTIAL_CONTENT : HttpStatus.OK);

    // Pipe rather than buffer: memory stays flat regardless of video size.
    target.body.pipe(res);
  }

  @Public()
  @UseGuards(OptionalJwtAuthGuard)
  @Get(':publicId/download')
  @ApiOperation({
    summary: 'Download the original video file',
    description:
      'Redirects to a short-lived presigned URL that forces a file download. The bytes are served by the object storage — they do not pass through this API.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to the presigned download URL',
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready for playback yet',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async download(
    @Param('publicId') publicId: string,
    @Res() res: Response,
    @CurrentUser() user?: JwtPayload,
  ): Promise<void> {
    const url = await this.videosService.getDownloadUrl(publicId, user?.sub);

    res.redirect(HttpStatus.FOUND, url);
  }
}
