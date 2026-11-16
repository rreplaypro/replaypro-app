// Ponte da versão web (iPhone e navegador): faz o papel do Java do app Android.
// A tela replays.html é a mesma do app; aqui ficam a leitura da planilha e da nuvem, a memória da quadra
// escolhida (no próprio navegador) e o baixar/compartilhar do celular.
(function () {
  const CHAVE = 'AIzaSyAMrmEdxa5F8l1ppZdBNsijGniuDaesrT8';
  const PLANILHA = '1JlpiJc6o3fOH6ScLFNclYbSJ6JFFlEshvXKU6HCB22k';

  const memoria = {
    ler(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } },
    gravar(k, v) { try { localStorage.setItem(k, v); } catch (e) { } }
  };

  async function drive(q, campos) {
    const r = await fetch('https://www.googleapis.com/drive/v3/files?pageSize=200&orderBy=name%20desc&q=' + encodeURIComponent(q)
      + '&fields=' + encodeURIComponent(campos) + '&key=' + encodeURIComponent(CHAVE));
    const j = await r.json();
    if (!r.ok) throw new Error((j.error && j.error.message) || ('HTTP ' + r.status));
    return j;
  }

  // CSV com aspas ("a, b" e "" dentro de aspas)
  function lerCsv(texto) {
    const linhas = []; let linha = [], campo = '', aspas = false;
    for (let i = 0; i < texto.length; i++) {
      const c = texto[i];
      if (aspas) {
        if (c === '"' && texto[i + 1] === '"') { campo += '"'; i++; }
        else if (c === '"') aspas = false;
        else campo += c;
      } else if (c === '"') aspas = true;
      else if (c === ',') { linha.push(campo); campo = ''; }
      else if (c === '\n') { linha.push(campo); campo = ''; linhas.push(linha); linha = []; }
      else if (c !== '\r') campo += c;
    }
    if (campo || linha.length) { linha.push(campo); linhas.push(linha); }
    return linhas;
  }
  const semAcento = t => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  function idDaPasta(link) {
    link = (link || '').trim();
    let m = link.match(/folders\/([A-Za-z0-9_-]+)/) || link.match(/[?&]id=([A-Za-z0-9_-]+)/);
    if (m) return m[1];
    return /^[A-Za-z0-9_-]{15,}$/.test(link) ? link : '';
  }
  function idDoArquivo(link) {
    link = (link || '').trim();
    if (!link) return '';
    let m = link.match(/\/d\/([A-Za-z0-9_-]+)/) || link.match(/[?&]id=([A-Za-z0-9_-]+)/);
    if (m) return m[1];
    return /^[A-Za-z0-9_-]{15,}$/.test(link) ? link : '';
  }

  // Planilha → [{id, nome, local, cidade, pasta, logo, gols, esporte, rede}]; as colunas são achadas pelo título da linha 1
  function lerPlanilha(csv) {
    const linhas = lerCsv(csv);
    if (!linhas.length) return [];
    let cId = -1, cLocal = -1, cNome = -1, cCidade = -1, cPasta = -1, cLogo = -1, cGols = -1, cEsporte = -1, cRede = -1;
    linhas[0].forEach((t, i) => {
      t = semAcento(t);
      if (t.startsWith('id')) cId = i;   // ID da câmera (QR code da quadra)
      else if (t.startsWith('local')) cLocal = i;
      else if (t.startsWith('quadra') || t === 'nome') cNome = i;
      else if (t.startsWith('cidade')) cCidade = i;
      else if (t.includes('pasta')) cPasta = i;
      else if (t.startsWith('logo')) cLogo = i;
      else if (t.startsWith('gols')) cGols = i;   // posição dos gols (recorte Stories), marcada no painel da câmera
      else if (t.startsWith('esporte')) cEsporte = i;   // muda o recorte (zoom, tênis)
      else if (t.startsWith('rede')) cRede = i;
    });
    if (cNome < 0 || cId < 0) throw new Error('Planilha sem as colunas Quadra e ID da câmera na linha 1.');
    const cel = (l, c) => (c >= 0 && c < l.length ? l[c].trim() : '');
    return linhas.slice(1).map(l => {
      const nome = cel(l, cNome), pasta = idDaPasta(cel(l, cPasta)), local = cel(l, cLocal);
      return { id: cel(l, cId), nome, local: local || nome, cidade: cel(l, cCidade), pasta, logo: idDoArquivo(cel(l, cLogo)), gols: cel(l, cGols), esporte: cel(l, cEsporte), rede: cel(l, cRede) };
    }).filter(q => q.nome && q.id);   // 16/11/2026: só R2
  }

  // Quadras sem logo na planilha usam o logo.png que o dono enviou pelo painel (uma consulta para todas)
  async function completarLogos(quadras) {
    try {
      const pastas = quadras.filter(q => !q.logo).map(q => q.pasta);
      const logoDaPasta = {};
      // 28/10: uma consulta por pasta (com "or" entre 2+ pastas o Drive recusa a chave de API: insufficientFilePermissions)
      await Promise.all(pastas.map(async p => {
        try {
          const r = await drive(`'${p}' in parents and name = 'logo.png' and trashed = false`, 'files(id)');
          if (r.files && r.files.length) logoDaPasta[p] = r.files[0].id;
        } catch (e) { }
      }));
      quadras.forEach(q => { if (!q.logo && logoDaPasta[q.pasta]) q.logo = logoDaPasta[q.pasta]; });
    } catch (e) { }   // sem logo: a tela mostra o ícone padrão
  }

  async function listarQuadras() {
    try {
      // 16/11/2026: lista da nuvem ReplayPro (ficha que cada câmera envia sozinha); a planilha do Google saiu
      const r = await fetch('https://replaypro.replaypro.workers.dev/quadras', { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const quadras = (await r.json()).quadras || [];
      memoria.gravar('lista', JSON.stringify(quadras));
      return JSON.stringify({ quadras });
    } catch (e) {
      const guardada = memoria.ler('lista');
      if (guardada) return JSON.stringify({ quadras: JSON.parse(guardada), offline: true });
      return JSON.stringify({ erro: e.message });
    }
  }

  async function consultaJson(q, campos, chave) {
    try { return JSON.stringify({ [chave]: (await drive(q, campos)).files || [] }); }
    catch (e) { return JSON.stringify({ erro: e.message }); }
  }

  window.App = {
    chaveApi: () => CHAVE,
    listarQuadras,
    lerQuadra: () => memoria.ler('quadra'),
    salvarQuadra: j => memoria.gravar('quadra', j),
    listarDias: id => consultaJson(`'${id.replace(/'/g, '')}' in parents and trashed = false and mimeType = 'application/vnd.google-apps.folder'`, 'files(id,name)', 'dias'),
    listarVideos: id => consultaJson(`'${id.replace(/'/g, '')}' in parents and trashed = false and mimeType contains 'video/'`, 'files(id,name,mimeType,size,thumbnailLink)', 'arquivos'),
    voltarInicio: () => { location.href = 'index.html'; },

    // iPhone: abre a folha de compartilhar com o vídeo, onde tem "Salvar vídeo". Sem isso, baixa ou abre o vídeo.
    baixar: async (url, nome) => {
      try {
        const blob = await (await fetch(url)).blob();
        const arquivo = new File([blob], nome.endsWith('.mp4') ? nome : nome + '.mp4', { type: 'video/mp4' });
        if (navigator.canShare && navigator.canShare({ files: [arquivo] })) { await navigator.share({ files: [arquivo] }); return; }
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob); a.download = arquivo.name;
        document.body.appendChild(a); a.click(); a.remove();
      } catch (e) {
        if (e && e.name === 'AbortError') return;   // a pessoa fechou a folha de compartilhar
        window.open(url, '_blank');
      }
    },
    compartilhar: async (link, titulo) => {
      try { if (navigator.share) { await navigator.share({ title: titulo, text: titulo, url: link }); return; } }
      catch (e) { if (e && e.name === 'AbortError') return; }
      try { await navigator.clipboard.writeText(titulo + '\n' + link); alert('Link copiado.'); }
      catch (e) { prompt('Copie o link:', link); }
    }
  };
})();
