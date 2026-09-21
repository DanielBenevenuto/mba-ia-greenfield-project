import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsString,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class CompletedPartDto {
  /** 1-based index of the part, as sent to the presigned URL. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  part_number: number;

  /** ETag returned by storage in the response of the part upload. */
  @IsString()
  @MinLength(1)
  etag: string;
}

export class CompleteUploadDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CompletedPartDto)
  parts: CompletedPartDto[];
}
