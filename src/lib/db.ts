import Dexie, { type Table } from 'dexie';

export interface AudioSession {
  id?: number;
  name: string;
  blob: Blob;
  createdAt: Date;
}

export interface Annotation {
  id?: number;
  sessionId: number;
  label: string;
  start: number;
  end: number;
  peakFreq: number;
}

export class BirdAudioDB extends Dexie {
  sessions!: Table<AudioSession, number>;
  annotations!: Table<Annotation, number>;

  constructor() {
    super('BirdAudioDB');
    this.version(1).stores({
      sessions: '++id, name, createdAt',
      annotations: '++id, sessionId, label, start, end',
    });
  }
}

export const db = new BirdAudioDB();
