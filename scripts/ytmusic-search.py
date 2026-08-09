#!/usr/bin/env python3
"""Search YouTube Music for albums.

Modes:
  python ytmusic-search.py "query"          -> single query, print JSON result
  python ytmusic-search.py --batch          -> read JSON array of queries from stdin,
                                               print JSON object {query: result}
"""
import json
import sys
from ytmusicapi import YTMusic

yt = YTMusic()

def search_one(query):
    try:
        results = yt.search(query, filter='albums', limit=1)
        if not results:
            return None
        item = results[0]
        playlist_id = item.get('playlistId')
        url = f"https://music.youtube.com/playlist?list={playlist_id}" if playlist_id else None
        return {
            'title': item.get('title'),
            'artist': ', '.join(a.get('name', '') for a in item.get('artists', [])),
            'year': item.get('year'),
            'url': url,
            'thumbnail': (item.get('thumbnails') or [{}])[-1].get('url'),
        }
    except Exception as e:
        return {'error': str(e)}

def batch(queries):
    out = {}
    for q in queries:
        out[q] = search_one(q)
    return out

if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--batch':
        queries = json.load(sys.stdin)
        result = batch(queries)
        print(json.dumps(result, ensure_ascii=False))
    elif len(sys.argv) > 1:
        query = ' '.join(sys.argv[1:])
        result = search_one(query)
        print(json.dumps(result, ensure_ascii=False))
    else:
        print(json.dumps({'error': 'Usage: ytmusic-search.py <query> or ytmusic-search.py --batch'}), file=sys.stderr)
        sys.exit(1)
