// Local face detection + embeddings via face-api (TensorFlow.js bundled).
// Model weights are served same-origin from /models — no photo pixels or
// biometric data ever leave the browser through this module.

import type { FaceBox } from '../types';

type FaceApi = typeof import('@vladmandic/face-api');

let faceapiPromise: Promise<FaceApi> | null = null;
let detectorReady = false;
let recognitionReady = false;

async function loadFaceApi(): Promise<FaceApi> {
  if (!faceapiPromise) {
    faceapiPromise = import('@vladmandic/face-api');
  }
  return faceapiPromise;
}

export async function ensureDetector(): Promise<FaceApi> {
  const faceapi = await loadFaceApi();
  if (!detectorReady) {
    await faceapi.nets.tinyFaceDetector.loadFromUri('/models');
    detectorReady = true;
  }
  return faceapi;
}

export async function ensureRecognition(): Promise<FaceApi> {
  const faceapi = await ensureDetector();
  if (!recognitionReady) {
    await Promise.all([
      faceapi.nets.faceLandmark68Net.loadFromUri('/models'),
      faceapi.nets.faceRecognitionNet.loadFromUri('/models'),
    ]);
    recognitionReady = true;
  }
  return faceapi;
}

/** Detect faces on a preview canvas; returns normalized boxes. */
export async function detectFaces(canvas: HTMLCanvasElement): Promise<FaceBox[]> {
  try {
    const faceapi = await ensureDetector();
    const detections = await faceapi.detectAllFaces(
      canvas,
      new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.4 }),
    );
    return detections.map((d) => ({
      x: d.box.x / canvas.width,
      y: d.box.y / canvas.height,
      w: d.box.width / canvas.width,
      h: d.box.height / canvas.height,
      score: d.score,
    }));
  } catch (err) {
    // Face detection is an enhancement — never fail the whole analysis.
    console.warn('Face detection unavailable:', err);
    return [];
  }
}

export interface FaceWithDescriptor {
  box: FaceBox;
  descriptor: Float32Array;
}

/** Detect faces and compute 128-d descriptors (for restricted matching). */
export async function detectFacesWithDescriptors(
  canvas: HTMLCanvasElement,
): Promise<FaceWithDescriptor[]> {
  const faceapi = await ensureRecognition();
  const results = await faceapi
    .detectAllFaces(
      canvas,
      new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.35 }),
    )
    .withFaceLandmarks()
    .withFaceDescriptors();
  return results.map((r) => ({
    box: {
      x: r.detection.box.x / canvas.width,
      y: r.detection.box.y / canvas.height,
      w: r.detection.box.width / canvas.width,
      h: r.detection.box.height / canvas.height,
      score: r.detection.score,
    },
    descriptor: r.descriptor,
  }));
}
