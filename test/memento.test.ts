import * as vscode from 'vscode';
import { MockMemento } from './mocks/vscode';

describe('MockMemento', () => {
  let memento: MockMemento;

  beforeEach(() => {
    memento = new MockMemento();
  });

  it('should store and retrieve values', async () => {
    await memento.update('testKey', 'testValue');
    expect(memento.get('testKey')).toBe('testValue');
  });

  it('should return undefined for non-existent keys', () => {
    expect(memento.get('nonExistent')).toBeUndefined();
  });

  it('should return default value for non-existent keys', () => {
    expect(memento.get('nonExistent', 'default')).toBe('default');
  });

  it('should delete keys when updated with undefined', async () => {
    await memento.update('testKey', 'testValue');
    expect(memento.get('testKey')).toBe('testValue');
    
    await memento.update('testKey', undefined);
    expect(memento.get('testKey')).toBeUndefined();
  });

  it('should return all keys', async () => {
    await memento.update('key1', 1);
    await memento.update('key2', 2);
    
    const keys = memento.keys();
    expect(keys).toContain('key1');
    expect(keys).toContain('key2');
    expect(keys.length).toBe(2);
  });
});
