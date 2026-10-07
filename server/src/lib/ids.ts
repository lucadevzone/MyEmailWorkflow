import { ulid } from 'ulid';

export const newId = (): string => ulid();
export const now = (): number => Date.now();
