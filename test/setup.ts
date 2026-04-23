/**
 * Jest test setup - runs before all tests
 */

// Mock fetch globally for all tests
(global as any).fetch = jest.fn();

// Import and expose vscode module for use in tests
import * as vscode from 'vscode';
(global as any).vscode = vscode;