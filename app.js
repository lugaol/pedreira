(() => {
  const state = {
    albums: [],
    stats: {},
    filtered: [],
    currentAlbum: null,
    sort: 'artist-asc',
    query: '',
    view: 'albums',
    expanded: false,
  };

  const elements = {
    app: document.querySelector('.app'),
    grid: document.getElementById('album-grid'),
    search: document.getElementById('search-input'),
    sort: document.getElementById('sort-select'),
    albumsView: document.getElementById('albums-view'),
    contributorsView: document.getElementById('contributors-view'),
    playerView: document.getElementById('player-view'),
    socialView: document.getElementById('social-view'),
    socialList: document.getElementById('social-list'),
    contributorsChart: document.getElementById('contributors-chart'),
    contributorsList: document.getElementById('contributors-list'),
    navItems: document.querySelectorAll('.nav-item'),
    statAlbums: document.getElementById('stat-albums'),
    statSenders: document.getElementById('stat-senders'),
    playerBar: document.getElementById('player-bar'),
    playerCover: document.getElementById('player-cover'),
    playerTitle: document.getElementById('player-title'),
    playerArtist: document.getElementById('player-artist'),
    playerFrame: document.getElementById('spotify-embed'),
    compactFrameContainer: document.getElementById('player-frame'),
    playerExpand: document.getElementById('player-expand'),
    playerOverlay: document.getElementById('player-overlay'),
    playerOverlayBackdrop: document.getElementById('player-overlay-backdrop'),
    playerOverlayClose: document.getElementById('player-overlay-close'),
    playerOverlayFrame: document.getElementById('player-overlay-frame'),
    playerOverlayCover: document.getElementById('player-overlay-cover'),
    playerOverlayTitle: document.getElementById('player-overlay-title'),
    playerOverlayArtist: document.getElementById('player-overlay-artist'),
    playerViewCover: document.getElementById('player-view-cover'),
    playerViewTitle: document.getElementById('player-view-title'),
    playerViewArtist: document.getElementById('player-view-artist'),
    playerViewFrame: document.getElementById('player-view-frame'),
  };

  async function init() {
    try {
      // Show loading state
      elements.grid.innerHTML = '<p class="view-subtitle">Loading albums...</p>';
      
      const res = await fetch('data.json');
      if (!res.ok) throw new Error('Could not load data.json');
      const data = await res.json();
      state.albums = data.albums || [];
      state.socialLinks = data.socialLinks || [];
      state.stats = data.stats || {};
      state.filtered = [...state.albums];
      updateStats();
      bindEvents();
      applySortAndFilter();
    } catch (err) {
      elements.grid.innerHTML = `<p class="view-subtitle">Failed to load albums: ${err.message}</p>`;
      console.error('Failed to initialize app:', err);
    }
  }

  function updateStats() {
    elements.statAlbums.textContent = state.albums.length.toLocaleString();
    elements.statSenders.textContent = (state.stats.topContributors?.length || 0).toLocaleString();
  }

  function updateNavState() {
    // Update sidebar nav
    elements.navItems.forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.view === state.view);
    });
    
    // Update bottom nav
    const bottomNavItems = document.querySelectorAll('.bottom-nav-item');
    bottomNavItems.forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.view === state.view);
    });
  }

  function bindEvents() {
    elements.search.addEventListener('input', (e) => {
      state.query = e.target.value.trim().toLowerCase();
      applySortAndFilter();
    });

    elements.sort.addEventListener('change', (e) => {
      state.sort = e.target.value;
      applySortAndFilter();
    });

    elements.navItems.forEach((btn) => {
      btn.addEventListener('click', () => {
        state.view = btn.dataset.view;
        updateNavState();
        renderView();
      });
    });

    // Bottom navigation for mobile
    const bottomNavItems = document.querySelectorAll('.bottom-nav-item');
    bottomNavItems.forEach((btn) => {
      btn.addEventListener('click', () => {
        state.view = btn.dataset.view;
        updateNavState();
        renderView();
      });
    });

    elements.playerExpand.addEventListener('click', openPlayerOverlay);
    elements.playerOverlayClose.addEventListener('click', closePlayerOverlay);
    elements.playerOverlayBackdrop.addEventListener('click', closePlayerOverlay);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && state.expanded) closePlayerOverlay();
    });
  }

  function renderView() {
    elements.albumsView.classList.toggle('hidden', state.view !== 'albums');
    elements.contributorsView.classList.toggle('hidden', state.view !== 'contributors');
    elements.playerView.classList.toggle('hidden', state.view !== 'player');
    elements.socialView.classList.toggle('hidden', state.view !== 'social');

    // Show loading states for views that need data
    if (state.view === 'albums' && !state.albums.length) {
      elements.grid.innerHTML = '<p class="view-subtitle">Loading albums...</p>';
    } else if (state.view === 'contributors' && !(state.stats.topContributors || []).length) {
      elements.contributorsChart.innerHTML = '<p class="view-subtitle">Loading contributors...</p>';
      elements.contributorsList.innerHTML = '';
    } else if (state.view === 'social' && !(state.socialLinks || []).length) {
      elements.socialList.innerHTML = '<p class="view-subtitle">Loading social links...</p>';
    }

    // Player view transforms the bottom bar into a full-size player panel.
    const isPlayerView = state.view === 'player';
    elements.app.classList.toggle('player-view-active', isPlayerView);

    // Reset player state when leaving player view
    if (!isPlayerView && state.expanded) {
      closePlayerOverlay();
    }
    
    // Hide player bar when no album is selected and not in player view
    if (!isPlayerView && !state.currentAlbum) {
      elements.playerBar.classList.add('hidden');
    }

    if (state.view === 'contributors' && (state.stats.topContributors || []).length) {
      renderContributors();
    } else if (state.view === 'player') {
      ensurePlayerFrameInBottomBar();
    } else if (state.view === 'social' && (state.socialLinks || []).length) {
      renderSocial();
      ensurePlayerFrameInBottomBar();
    } else {
      ensurePlayerFrameInBottomBar();
    }
  }

  function ensurePlayerFrameInBottomBar() {
    if (state.expanded) return;
    movePlayerFrame(elements.compactFrameContainer, 152);
  }

  function applySortAndFilter() {
    const q = state.query;
    let list = state.albums;

    if (q) {
      list = list.filter(
        (a) =>
          (a.name || '').toLowerCase().includes(q) ||
          (a.artist || '').toLowerCase().includes(q) ||
          a.senders.some((s) => s.toLowerCase().includes(q))
      );
    }

    list = sortAlbums(list, state.sort);
    state.filtered = list;
    renderAlbums();
  }

  function sortAlbums(list, sort) {
    const sorted = [...list];
    switch (sort) {
      case 'artist-asc':
        return sorted.sort(cmpArtist);
      case 'artist-desc':
        return sorted.sort((a, b) => cmpArtist(b, a));
      case 'album-asc':
        return sorted.sort(cmpAlbum);
      case 'album-desc':
        return sorted.sort((a, b) => cmpAlbum(b, a));
      case 'recent':
        return sorted.sort((a, b) => new Date(b.lastSharedAt || 0) - new Date(a.lastSharedAt || 0));
      default:
        return sorted;
    }
  }

  function cmpArtist(a, b) {
    const artistA = (a.artist || '').toLowerCase();
    const artistB = (b.artist || '').toLowerCase();
    if (artistA !== artistB) return artistA.localeCompare(artistB);
    return cmpAlbum(a, b);
  }

  function cmpAlbum(a, b) {
    return (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase());
  }

  function renderAlbums() {
    const { filtered } = state;
    if (!filtered.length) {
      if (state.query) {
        elements.grid.innerHTML = '<p class="view-subtitle">No albums match your search.</p>';
      } else {
        elements.grid.innerHTML = '<p class="view-subtitle">No albums found in the library.</p>';
      }
      return;
    }

    const html = filtered
      .map((album) => {
        const canPlay = !!album.spotifyId;
        const cover = album.image || 'stone.svg';
        const actionLabel = canPlay ? `Play ${escapeHtml(album.name)}` : `Open ${escapeHtml(album.name)}`;
        const actionIcon = canPlay
          ? '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>'
          : '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M19 19H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/></svg>';
        return `
      <article class="album-card" data-id="${album.id}">
        <div class="album-cover-wrap">
          <img class="album-cover" src="${cover}" alt="${escapeHtml(album.name)}" loading="lazy" />
          <button class="play-button ${canPlay ? '' : 'external'}" data-id="${album.id}" aria-label="${actionLabel}">
            ${actionIcon}
          </button>
        </div>
        <h3 class="album-title" title="${escapeHtml(album.name)}">${escapeHtml(album.name)}</h3>
        <p class="album-artist" title="${escapeHtml(album.artist)}">${escapeHtml(album.artist)}</p>
        <div class="album-meta">
          <span>${album.releaseDate ? album.releaseDate.slice(0, 4) : '—'}</span>
          <span class="dot"></span>
          <span>${album.senderCount} sender${album.senderCount === 1 ? '' : 's'}</span>
        </div>
        ${renderSenderPills(album.senders)}
      </article>
    `;
      })
      .join('');

    elements.grid.innerHTML = html;

    elements.grid.querySelectorAll('.album-card').forEach((card) => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.play-button')) {
          e.stopPropagation();
          const id = e.target.closest('.play-button').dataset.id;
          playAlbum(id);
        } else {
          const id = card.dataset.id;
          playAlbum(id);
        }
      });
    });
  }

  function renderSenderPills(senders) {
    if (!senders || !senders.length) return '';
    const visible = senders.slice(0, 3);
    const rest = senders.length - visible.length;
    let html = visible.map((s) => `<span class="sender-pill" title="${escapeHtml(s)}">${escapeHtml(s)}</span>`).join('');
    if (rest > 0) html += `<span class="sender-pill">+${rest}</span>`;
    return `<div class="sender-pills">${html}</div>`;
  }

  function getSpotifyEmbedUrl(spotifyId, autoplay = true) {
    // Put autoplay first; it is still subject to browser policies, but this is the most reliable URL format.
    let url = `https://open.spotify.com/embed/album/${spotifyId}?autoplay=${autoplay ? '1' : '0'}`;
    url += '&theme=0';
    return url;
  }

  function updatePlayerInfo(album) {
    elements.playerTitle.textContent = album.name;
    elements.playerArtist.textContent = album.artist;
    elements.playerCover.src = album.image || 'stone.svg';

    elements.playerViewCover.src = album.image || 'stone.svg';
    elements.playerViewTitle.textContent = album.name;
    elements.playerViewArtist.textContent = album.artist || 'Choose an album from the library to start listening.';

    elements.playerOverlayCover.src = album.image || 'stone.svg';
    elements.playerOverlayTitle.textContent = album.name;
    elements.playerOverlayArtist.textContent = album.artist;
    
    // Show player bar when an album is selected
    elements.playerBar.classList.remove('hidden');
  }

  function playAlbum(id) {
    const album = state.albums.find((a) => a.id === id);
    if (!album) return;

    if (!album.spotifyId) {
      if (album.externalUrl) {
        window.open(album.externalUrl, '_blank', 'noopener,noreferrer');
      }
      return;
    }

    state.currentAlbum = album;
    updatePlayerInfo(album);

    // Load the album with autoplay. The active layout (bottom bar or overlay) decides the iframe size.
    const target = state.expanded ? elements.playerOverlayFrame : elements.compactFrameContainer;
    
    if (state.expanded) {
      movePlayerFrame(target, 380);
    } else {
      // Use CSS-calculated height for compact player
      movePlayerFrame(target, null);
    }
    
    elements.playerFrame.src = getSpotifyEmbedUrl(album.spotifyId, true);

    // Scroll to player on mobile
    if (window.innerWidth <= 900 && state.view !== 'player') {
      elements.playerBar.scrollIntoView({ behavior: 'smooth' });
    }
  }

  function movePlayerFrame(container, height) {
    if (!elements.playerFrame || !container) return;
    // Avoid DOM thrashing if the iframe is already in the target container.
    if (elements.playerFrame.parentNode !== container) {
      container.appendChild(elements.playerFrame);
    }
    if (height !== null) {
      elements.playerFrame.setAttribute('height', String(height));
    }
  }

  function openPlayerOverlay() {
    if (!state.currentAlbum) return;
    state.expanded = true;
    elements.playerOverlay.classList.add('active');
    elements.playerOverlay.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';

    movePlayerFrame(elements.playerOverlayFrame, 380);
  }

  function closePlayerOverlay() {
    if (!state.expanded) return;
    state.expanded = false;
    elements.playerOverlay.classList.remove('active');
    elements.playerOverlay.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';

    // Return iframe to the compact bottom bar.
    movePlayerFrame(elements.compactFrameContainer, null);
    
    // If we're not in player view, ensure the player bar is visible
    if (state.view !== 'player') {
      elements.playerBar.classList.remove('hidden');
    }
  }

  function renderSocial() {
    const links = state.socialLinks || [];
    if (!links.length) {
      elements.socialList.innerHTML = '<p class="view-subtitle">No social media links found.</p>';
      return;
    }

    const platformIcon = (platform) => {
      const icons = {
        apple_music: '',
        bandcamp: 'BC',
        deezer: 'DZ',
        tidal: 'T',
        soundcloud: 'SC',
        social: '🔗',
      };
      return icons[platform] || '🔗';
    };

    elements.socialList.innerHTML = links
      .map(
        (link) => `
      <article class="social-item">
        <div class="social-icon" title="${escapeHtml(link.platform)}">${platformIcon(link.platform)}</div>
        <div class="social-info">
          <a class="social-url" href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(link.url)}">${escapeHtml(link.url)}</a>
          <div class="social-meta">Shared by ${escapeHtml(link.sender)}${link.sharedAt ? ' · ' + formatDate(link.sharedAt) : ''}</div>
        </div>
        <div class="social-arrow">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M8.59 16.59 13.17 12 8.59 7.41 10 6l6 6-6 6-1.41-1.41z"/></svg>
        </div>
      </article>
    `
      )
      .join('');
  }

  function formatDate(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function renderContributors() {
    const contributors = state.stats.topContributors || [];
    if (!contributors.length) {
      elements.contributorsChart.innerHTML = '<p class="view-subtitle">No contributor data.</p>';
      elements.contributorsList.innerHTML = '';
      return;
    }

    const max = contributors[0].uniqueAlbums || 1;

    elements.contributorsChart.innerHTML = contributors
      .map(
        (c) => `
      <div class="contributor-bar">
        <div class="contributor-name" title="${escapeHtml(c.name)}">${escapeHtml(c.name)}</div>
        <div class="contributor-track">
          <div class="contributor-fill" style="width: ${(c.uniqueAlbums / max) * 100}%"></div>
        </div>
        <div class="contributor-count">${c.uniqueAlbums}</div>
      </div>
    `
      )
      .join('');

    elements.contributorsList.innerHTML = contributors
      .map(
        (c) => `
      <li>
        <span class="name">${escapeHtml(c.name)}</span>
        <span class="count">${c.uniqueAlbums}</span>
      </li>
    `
      )
      .join('');
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  init();
})();
