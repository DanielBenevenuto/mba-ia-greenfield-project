import { Type } from 'class-transformer';
import { IsInt, IsString, MaxLength, Min, MinLength } from 'class-validator';

export class CreateUploadDto {
  /** Original file name on the uploader's machine, e.g. `holiday.mp4`. */
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  filename: string;

  /**
   * Declared size of the file in bytes. The 10 GiB ceiling is a domain rule and
   * answers 413 VIDEO_TOO_LARGE, not a 400 validation error.
   */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  size_bytes: number;

  /** MIME type of the file, e.g. `video/mp4`. */
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  content_type: string;
}
