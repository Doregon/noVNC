/*
 * noVNC: HTML5 VNC client
 * Copyright (C) 2021 The noVNC Authors
 * Licensed under MPL 2.0 (see LICENSE.txt)
 *
 * See README.md for usage and integration instructions.
 *
 */

import Inflate from "../inflator.js";

const ZRLE_TILE_WIDTH = 64;
const ZRLE_TILE_HEIGHT = 64;

export default class ZRLEDecoder {
    constructor() {
        this._length = 0;
        this._offset = 0;
        this._inflator = new Inflate();

        this._pixelBuffer = new Uint8Array(ZRLE_TILE_WIDTH * ZRLE_TILE_HEIGHT * 4);
        this._tileBuffer = new Uint8Array(ZRLE_TILE_WIDTH * ZRLE_TILE_HEIGHT * 4);
    }

    decodeRect(x, y, width, height, sock, display, depth) {

        if (this._length === 0) {
            if (sock.rQwait("ZLib data length", 4)) {
                return false;
            }
            this._length = sock.rQshift32();
        }
        if (sock.rQwait("Zlib data", this._length)) {
            return false;
        }

        const data = sock.rQshiftBytes(this._length);

        this._inflator.setInput(data);

        this._readBuffer = this._inflator.inflate(width * height * 3 + 1024, true);

        for (let ty = y; ty < y + height; ty += ZRLE_TILE_HEIGHT) {
            let th = Math.min(ZRLE_TILE_HEIGHT, y + height - ty);

            for (let tx = x; tx < x + width; tx += ZRLE_TILE_WIDTH) {
                let tw = Math.min(ZRLE_TILE_WIDTH, x + width - tx);

                const tileSize = tw * th;
                const subencoding = this._readBuffer[this._offset++];
                if (subencoding === 0) {
                    // raw data
                    const data = this._readPixels(tileSize);
                    display.blitImage(tx, ty, tw, th, data, 0, false);
                } else if (subencoding === 1) {
                    // solid
                    const background = this._readPixels(1);
                    display.fillRect(tx, ty, tw, th, [background[0], background[1], background[2]]);
                } else if (subencoding >= 2 && subencoding <= 16) {
                    const data = this._decodePaletteTile(subencoding, tileSize, tw, th);
                    display.blitImage(tx, ty, tw, th, data, 0, false);
                } else if (subencoding === 128) {
                    const data = this._decodeRLETile(tileSize);
                    display.blitImage(tx, ty, tw, th, data, 0, false);
                } else if (subencoding >= 130 && subencoding <= 255) {
                    const data = this._decodeRLEPaletteTile(subencoding - 128, tileSize);
                    display.blitImage(tx, ty, tw, th, data, 0, false);
                } else {
                    throw new Error('Unknown subencoding: ' + subencoding);
                }
            }
        }
        this._readBuffer = null;
        this._length = 0;
        this._offset = 0;
        return true;
    }

    _getBitsPerPixelInPalette(paletteSize) {
        if (paletteSize <= 2) {
            return 1;
        } else if (paletteSize <= 4) {
            return 2;
        } else if (paletteSize <= 16) {
            return 4;
        }
    }

    _readPixels(pixels) {
        let data = this._pixelBuffer;
        for (let i = 0, j = 0; i < pixels*4; i += 4, j += 3) {
            data[i]     = this._readBuffer[this._offset + j];
            data[i + 1] = this._readBuffer[this._offset + j + 1];
            data[i + 2] = this._readBuffer[this._offset + j + 2];
            data[i + 3] = 255;  // Add the Alpha
        }
        this._offset += pixels * 3;
        return data;
    }

    _decodePaletteTile(paletteSize, tileSize, tilew, tileh) {
        const data = this._tileBuffer;
        const palette = this._readPixels(paletteSize);
        const bitsPerPixel = this._getBitsPerPixelInPalette(paletteSize);
        const mask = (1 << bitsPerPixel) - 1;

        let offset = 0;
        for (let y=0; y<tileh; y++) {
            let shift = 8-bitsPerPixel;
            for (let x=0; x<tilew; x++) {
                let encoded = this._readBuffer[this._offset];
                let indexInPalette = (encoded>>shift) & mask;

                data[offset] = palette[indexInPalette * 4];
                data[offset + 1] = palette[indexInPalette * 4 + 1];
                data[offset + 2] = palette[indexInPalette * 4 + 2];
                data[offset + 3] = palette[indexInPalette * 4 + 3];
                offset += 4;

                shift-=bitsPerPixel;
                if (shift<0) {
                    shift=8-bitsPerPixel;
                    this._offset++;
                }
            }
            if (shift<8-bitsPerPixel) {
                this._offset++;
            }
        }
        return data;
    }

    _decodeRLETile(tileSize) {
        const data = this._tileBuffer;
        let i = 0;
        while (i < tileSize) {
            const pixel = this._readPixels(1);
            const length = this._readRLELength();
            for (let j = 0; j < length; j++) {
                data[i * 4] = pixel[0];
                data[i * 4 + 1] = pixel[1];
                data[i * 4 + 2] = pixel[2];
                data[i * 4 + 3] = pixel[3];
                i++;
            }
        }
        return data;
    }

    _decodeRLEPaletteTile(paletteSize, tileSize) {
        const data = this._tileBuffer;

        // palette
        const palette = this._readPixels(paletteSize);

        let offset = 0;
        while (offset < tileSize) {
            let indexInPalette = this._readBuffer[this._offset++];
            let length = 1;
            if (indexInPalette >= 128) {
                indexInPalette -= 128;
                length = this._readRLELength();
            }
            if (indexInPalette > paletteSize) {
                throw new Error('Too big index in palette: ' + indexInPalette + ', palette size: ' + paletteSize);
            }
            if (offset + length > tileSize) {
                throw new Error('Too big rle length in palette mode: ' + length + ', allowed length is: ' + (tileSize - offset));
            }

            for (let j = 0; j < length; j++) {
                data[offset * 4] = palette[indexInPalette * 4];
                data[offset * 4 + 1] = palette[indexInPalette * 4 + 1];
                data[offset * 4 + 2] = palette[indexInPalette * 4 + 2];
                data[offset * 4 + 3] = palette[indexInPalette * 4 + 3];
                offset++;
            }
        }
        return data;
    }

    _readRLELength() {
        let length = 0;
        let current = 0;
        do {
            current = this._readBuffer[this._offset++];
            length += current;
        } while (current === 255);
        return length + 1;
    }
}