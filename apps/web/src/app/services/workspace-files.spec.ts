/**
 * What {@link WorkspaceFiles} promises a content picker: a listing that only
 * fills once a server has answered, kind-filtered views of it, and an upload
 * that lands the file and returns its path.
 */
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { WorkspaceFiles } from './workspace-files';
import { ContentWorkspaceService, WorkspaceFile, WorkspaceStatus } from './content-workspace.service';

function file(path: string): WorkspaceFile {
  return { path, size: 1, modifiedAt: '2026-01-01T00:00:00.000Z' };
}

class FakeContentWorkspace {
  private state: WorkspaceStatus | null = null;
  status = (): WorkspaceStatus | null => this.state;
  setStatus(state: WorkspaceStatus | null): void {
    this.state = state;
  }
  list = vi.fn(async (): Promise<readonly WorkspaceFile[]> => []);
  write = vi.fn(async (): Promise<void> => {});
}

describe('WorkspaceFiles', () => {
  let workspace: FakeContentWorkspace;
  let files: WorkspaceFiles;

  beforeEach(() => {
    workspace = new FakeContentWorkspace();
    TestBed.configureTestingModule({
      providers: [WorkspaceFiles, { provide: ContentWorkspaceService, useValue: workspace }],
    });
    files = TestBed.inject(WorkspaceFiles);
  });

  it('stays empty until a server has answered', async () => {
    workspace.setStatus(null);
    await files.refresh();
    expect(files.all()).toEqual([]);
    expect(workspace.list).not.toHaveBeenCalled();
  });

  it('reads the directory once a server answers', async () => {
    workspace.setStatus({ root: '/c', readOnly: false });
    workspace.list.mockResolvedValue([file('a.png'), file('song.ogg')]);
    await files.refresh();
    expect(files.all()).toHaveLength(2);
  });

  it('splits the listing by kind', async () => {
    workspace.setStatus({ root: '/c', readOnly: false });
    workspace.list.mockResolvedValue([
      file('sprites/hero.png'),
      file('bg/title.jpg'),
      file('music/theme.ogg'),
      file('notes.txt'),
    ]);
    await files.refresh();
    expect(files.images().map((f) => f.path)).toEqual(['sprites/hero.png']);
    expect(files.pictures().map((f) => f.path)).toEqual(['sprites/hero.png', 'bg/title.jpg']);
    expect(files.tracks().map((f) => f.path)).toEqual(['music/theme.ogg']);
  });

  it('keeps a listing when a refresh fails', async () => {
    workspace.setStatus({ root: '/c', readOnly: false });
    workspace.list.mockResolvedValueOnce([file('a.png')]);
    await files.refresh();
    workspace.list.mockRejectedValueOnce(new Error('server gone'));
    await files.refresh();
    expect(files.all().map((f) => f.path)).toEqual(['a.png']);
  });

  it('uploads under the file name and returns the path', async () => {
    workspace.setStatus({ root: '/c', readOnly: false });
    workspace.list.mockResolvedValue([]);
    const blob = new File([new Uint8Array([1])], 'hero.png', { type: 'image/png' });
    const path = await files.upload(blob, 'assets/images');
    expect(path).toBe('assets/images/hero.png');
    expect(workspace.write).toHaveBeenCalledWith('assets/images/hero.png', blob);
    expect(workspace.list).toHaveBeenCalled();
  });
});
