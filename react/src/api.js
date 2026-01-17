/**
 * API client for Humdard Lyrics Learning API
 */

const API_BASE_URL = 'https://humdard-lyric-api.sh0vel.workers.dev';

export async function listSongs() {
    const response = await fetch(`${API_BASE_URL}/api/songs`);
    if (!response.ok) {
        throw new Error(`Failed to list songs: ${response.statusText}`);
    }
    return response.json();
}

export async function getSong(songId, includeTokens = true) {
    const url = `${API_BASE_URL}/api/songs/${songId}${includeTokens ? '' : '?tokens=false'}`;
    const response = await fetch(url);
    if (!response.ok) {
        if (response.status === 404) {
            throw new Error('Song not found');
        }
        throw new Error(`Failed to get song: ${response.statusText}`);
    }
    return response.json();
}

export async function jsonifyLyrics(payload) {
    const response = await fetch(`${API_BASE_URL}/api/jsonify`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
    });

    if (!response.ok) {
        const error = await response.json().catch(() => ({ error: { message: response.statusText } }));
        throw new Error((error.error && error.error.message) || 'Failed to generate lyrics');
    }

    return response.json();
}

export async function deleteSong(songId) {
    const response = await fetch(`${API_BASE_URL}/api/songs/${songId}`, {
        method: 'DELETE',
    });

    if (!response.ok) {
        const error = await response.json().catch(() => ({ error: { message: response.statusText } }));
        throw new Error(error.error ? .message || 'Failed to delete song');
    }

    return response.json();
}