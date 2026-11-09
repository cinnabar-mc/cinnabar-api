import { MAX_COMPONENT_BYTES } from "./component";

export const MAX_IMAGE_BYTES = 1024 * 1024;
export const MAX_IMAGES = 4;
export const MAX_IMAGE_DIMENSION = 4096;
export const MAX_IMAGE_PIXELS = MAX_IMAGE_DIMENSION * MAX_IMAGE_DIMENSION;
export const MAX_IMAGE_CAPTION = 160;
export const MAX_IMAGE_ALT = 300;

/** Browser hints and server/scanner limits share one production policy; the API still validates every upload. */
export const UPLOAD_LIMITS = Object.freeze({ component_bytes: MAX_COMPONENT_BYTES, images: MAX_IMAGES,
  image_bytes: MAX_IMAGE_BYTES, image_dimension: MAX_IMAGE_DIMENSION, image_pixels: MAX_IMAGE_PIXELS,
  caption_chars: MAX_IMAGE_CAPTION, alt_chars: MAX_IMAGE_ALT });
