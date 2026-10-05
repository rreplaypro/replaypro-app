// ReplayPro - recorte inteligente feito no próprio celular (Stories 9:16 e Quadrado 1:1).
// A câmera não processa nada: o celular baixa o replay do Drive, acha onde está a jogada pelo movimento
// e grava a versão recortada com o gravador do próprio aparelho. Mesmos ajustes do recorte_ia.py da câmera.
// Usado pelo app Android (assets) e pela versão web (app.replaypro.com.br).
const Recorte = (() => {
  const LARGURA_ANALISE = 320, FPS_ANALISE = 10, CUSTO_MOVER = 0.02, SUAVIDADE_S = 0.6, VELOCIDADE_MAX = 0.9;
  const PESO_LONGE = 2, RAIO_GOL = 0.3, LANCE_MIN_S = 0.5, VELOCIDADE_ANALISE = 3;
  const ANTES_DO_GOL_S = 2.5, LARGURA_PICO = 0.2;   // trava no gol 2,5 s antes do momento marcado
  const DURACAO = 8, ANTES = 6;                      // o recorte tem 8 s: 6 antes do momento marcado e 2 depois
  // Por esporte (escolhido no painel da câmera). zoom: fica só com o centro da imagem antes de recortar, como uma lente
  // mais fechada (1,3 ≈ 3,6 mm). doisLados: tênis, segue o jogador de perto e puxa para o do fundo (rede = divisão).
  const ESPORTES = {
    futebol: { zoom: 1, gols: true, nome: 'Futebol' },
    beach: { zoom: 1.3, gols: false, nome: 'Beach tennis' },
    tenis: { zoom: 1.3, gols: false, doisLados: true, rede: 0.27, nome: 'Tênis' },
  };
  const esporte = e => ESPORTES[String(e || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s.*/, '')] || ESPORTES.futebol;
  const FORMATOS = { stories: { prop: [9, 16], saida: [720, 1280], nome: 'Stories' },
                     quadrado: { prop: [1, 1], saida: [1080, 1080], nome: 'Quadrado' } };

  // ---------- áudio: preparado no toque do botão (o iPhone só libera som depois de um toque) ----------
  let audioCtx = null;
  function prepararAudio() {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state !== 'running') return audioCtx.resume().catch(() => {});
    } catch (e) { audioCtx = null; }
    return Promise.resolve();
  }
  const audioPronto = () => !!audioCtx && audioCtx.state === 'running';

  // ---------- baixar o replay inteiro ----------
  async function baixar(url, aoProgresso, sinal) {
    const r = await fetch(url, { signal: sinal });
    if (!r.ok) throw new Error('o Drive respondeu ' + r.status);
    const total = +r.headers.get('content-length') || 0, partes = [];
    let lido = 0;
    const leitor = r.body.getReader();
    for (;;) {
      const { done, value } = await leitor.read();
      if (done) break;
      partes.push(value); lido += value.length;
      if (total) aoProgresso(lido / total);
    }
    return new Blob(partes, { type: 'video/mp4' });
  }

  function esperar(el, ev) {
    return new Promise((ok, erro) => {
      const f = () => { limpar(); ok(); };
      const e = () => { limpar(); erro(new Error('o vídeo não abriu neste celular')); };
      const limpar = () => { el.removeEventListener(ev, f); el.removeEventListener('error', e); };
      el.addEventListener(ev, f); el.addEventListener('error', e);
    });
  }

  async function abrirVideo(blob) {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.setAttribute('playsinline', ''); v.preload = 'auto';
    v.style.cssText = 'position:fixed;left:-9999px;top:0;width:2px;height:2px;';   // fora da tela, mas "visível" para o celular decodificar
    document.body.appendChild(v);
    v.src = URL.createObjectURL(blob);
    await esperar(v, 'loadedmetadata');
    try { await v.play(); } catch (e) { /* o seek abaixo também carrega */ }   // celular só carrega a imagem depois de um play
    v.pause();
    return v;
  }
  function fecharVideo(v) {
    if (!v) return;
    try { v.pause(); URL.revokeObjectURL(v.src); v.removeAttribute('src'); v.load(); v.remove(); } catch (e) { }
  }

  // ---------- análise do movimento: imagens pequenas, ~10 por segundo ----------
  // faixa: [y0, y1] (0 a 1) que aparece com o zoom. divisao: tênis, altura da rede (0 a 1); null = sem os dois lados
  function criarAnalisador(W, H, faixa, divisao) {
    const w = LARGURA_ANALISE, h = Math.round(LARGURA_ANALISE * H / W);
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    const peso = new Float32Array(h);
    const lado = new Int8Array(h);   // tênis: -1 fora, 0 fundo (acima da rede), 1 perto
    for (let y = 0; y < h; y++) {
      const fy = (y + 0.5) / h, dentro = fy >= faixa[0] && fy <= faixa[1];
      peso[y] = dentro ? Math.pow(1 / (0.15 + fy), PESO_LONGE) : 0;   // longe (em cima) pesa mais; fora do zoom não conta
      lado[y] = !dentro || divisao == null ? -1 : (fy < divisao ? 0 : 1);
    }
    const cinza = new Float32Array(w * h), borrado = new Float32Array(w * h), m = new Uint8Array(w * h), m2 = new Uint8Array(w * h);
    let anterior = null;
    const tempos = [], colunas = [], lados = [];
    function quadro(video, t) {
      ctx.drawImage(video, 0, 0, w, h);
      const px = ctx.getImageData(0, 0, w, h).data;
      for (let i = 0, j = 0; i < w * h; i++, j += 4) cinza[i] = 0.299 * px[j] + 0.587 * px[j + 1] + 0.114 * px[j + 2];
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {     // borrão 3x3: tira o chuvisco da imagem
        let s = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) { const yy = y + dy; if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) { const xx = x + dx; if (xx < 0 || xx >= w) continue; s += cinza[yy * w + xx]; n++; } }
        borrado[y * w + x] = s / n;
      }
      if (anterior) {
        for (let i = 0; i < w * h; i++) m[i] = Math.abs(borrado[i] - anterior[i]) > 16 ? 1 : 0;
        m2.fill(0);   // abertura 2x2: some com pontos soltos
        for (let y = 0; y < h - 1; y++) for (let x = 0; x < w - 1; x++) { const i = y * w + x; m2[i] = m[i] & m[i + 1] & m[i + w] & m[i + w + 1]; }
        const col = new Float32Array(w), fundo = new Float32Array(w), perto = new Float32Array(w);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const i = y * w + x;
          if (m2[i] || (x > 0 && m2[i - 1]) || (y > 0 && m2[i - w]) || (x > 0 && y > 0 && m2[i - w - 1])) {
            col[x] += peso[y];
            if (lado[y] === 0) fundo[x]++; else if (lado[y] === 1) perto[x]++;
          }
        }
        tempos.push(t); colunas.push(col);
        if (divisao != null) lados.push([fundo, perto]);
      }
      anterior = Float32Array.from(borrado);
    }
    return { quadro, dados: () => ({ W, H, tempos, colunas, lados: divisao != null ? lados : null }) };
  }

  // Lê os quadros tocando o vídeo mudo e acelerado (bem mais leve que pular de quadro em quadro).
  // Sem requestVideoFrameCallback (navegador antigo), pula de 0,1 em 0,1 s.
  async function analisar(video, inicio, fim, faixa, divisao, aoProgresso, sinal) {
    const an = criarAnalisador(video.videoWidth, video.videoHeight, faixa, divisao), dur = fim - inicio;
    video.currentTime = inicio; await esperar(video, 'seeked');
    if (video.requestVideoFrameCallback) {
      await new Promise((ok, erro) => {
        let proximo = 0;
        let acabou = false;
        const terminar = () => { if (acabou) return; acabou = true; video.removeEventListener('ended', terminar); video.pause(); ok(); };
        proximo = inicio;
        const cada = (agora, meta) => {
          if (acabou) return;
          if (sinal.aborted) { acabou = true; video.pause(); erro(new DOMException('cancelado', 'AbortError')); return; }
          const t = meta.mediaTime;
          if (t >= fim) { terminar(); return; }
          if (t >= proximo) { an.quadro(video, t); proximo = t + 1 / FPS_ANALISE; aoProgresso((t - inicio) / dur); }
          if (!video.ended) video.requestVideoFrameCallback(cada);
        };
        video.addEventListener('ended', terminar);
        video.requestVideoFrameCallback(cada);
        video.playbackRate = VELOCIDADE_ANALISE;
        video.play().catch(erro);
      });
      video.playbackRate = 1;
    } else {
      for (let t = inicio + 0.05; t < fim - 0.05; t += 1 / FPS_ANALISE) {
        if (sinal.aborted) throw new DOMException('cancelado', 'AbortError');
        video.currentTime = t; await esperar(video, 'seeked');
        an.quadro(video, t); aoProgresso((t - inicio) / dur);
      }
    }
    return an.dados();
  }

  // ---------- caminho do quadro (mesma conta da câmera) ----------
  function lanceNoGol(pico, tempos, gols, pt) {
    if (!gols.length || tempos.length < 2) return null;
    const folga = Math.round(1 / pt);
    let melhor = null, notaMelhor = 0;
    for (const g of gols) {
      const perto = pico.map(p => Math.abs(p - g) < RAIO_GOL);
      let i = 0;
      while (i < perto.length) {
        if (!perto[i]) { i++; continue; }
        let fim = i;
        for (;;) {   // junta trechos separados por menos de 1 s
          let j = fim + 1; while (j < perto.length && perto[j]) j++; fim = j - 1;
          let k = -1; for (let d = 1; d <= folga && fim + d < perto.length; d++) if (perto[fim + d]) { k = fim + d; break; }
          if (k < 0) break; fim = k;
        }
        const t0 = tempos[0], tN = tempos[tempos.length - 1];
        const dur = (fim - i + 1) * pt, nota = dur * (0.5 + 0.5 * (tempos[fim] - t0) / Math.max(1e-6, tN - t0));   // lance no fim vale mais
        if (dur >= LANCE_MIN_S && nota > notaMelhor) { melhor = [g, i]; notaMelhor = nota; }
        i = fim + 1;
      }
    }
    return melhor;
  }

  // Centro da jogada em cada instante (0 a 1), com a mesma janela estreita para todos os formatos
  function ondeEstaAJogada(colunas, nCol) {
    const la = Math.max(2, Math.round(LARGURA_PICO * nCol)), P = nCol - la + 1;
    return colunas.map(c => {
      let s = 0; for (let x = 0; x < la; x++) s += c[x];
      let melhor = s, arg = 0;
      for (let p = 1; p < P; p++) { s += c[p + la - 1] - c[p - 1]; if (s > melhor) { melhor = s; arg = p; } }
      return (arg + la / 2) / nCol;
    });
  }

  // Tênis: acha o jogador do fundo e o de perto (cada um no seu lado da rede). O de perto fica sempre dentro do
  // quadro (com margem) e, dentro disso, o quadro chega o mais perto possível do jogador do fundo. Devolve a trilha.
  function trilhaDoisLados(lados, nCol, la, P) {
    const larg = Math.max(3, Math.round(0.04 * nCol)), n = lados.length, pos = [];
    for (const l of [0, 1]) {
      const x = new Float32Array(n), forca = new Float32Array(n);
      lados.forEach((par, t) => {
        const c = par[l]; let s = 0, melhor = -1, arg = 0;
        for (let i = 0; i < nCol; i++) {   // janela do tamanho de um jogador
          s += c[i] - (i >= larg ? c[i - larg] : 0);
          if (s > melhor) { melhor = s; arg = i - (larg - 1) / 2; }
        }
        x[t] = arg; forca[t] = melhor;
      });
      const ord = Array.from(forca).sort((a, b) => a - b), limite = 0.15 * (ord[Math.floor(0.9 * (n - 1))] || 0);
      let ultimo = -1;   // parado ou sumiu: mantém onde estava
      for (let t = 0; t < n; t++) { if (forca[t] > limite) ultimo = x[t]; else x[t] = ultimo; }
      const primeiro = x.findIndex(v => v >= 0);
      for (let t = 0; t < n; t++) if (x[t] < 0) x[t] = primeiro >= 0 ? x[primeiro] : nCol / 2;
      pos.push(Array.from(x, (_, t) => { const j = x.slice(Math.max(0, t - 2), t + 3).sort((a, b) => a - b); return j[j.length >> 1]; }));   // mediana de 5
    }
    const folga = Math.max(0, la / 2 - 0.06 * nCol);
    return Int32Array.from(pos[0], (fundo, t) => {
      const centro = Math.min(pos[1][t] + folga, Math.max(pos[1][t] - folga, fundo));
      return Math.min(P - 1, Math.max(0, Math.round(centro - la / 2)));
    });
  }

  // O jogador marcou quando foi o gol: trava no gol marcado mais perto da jogada naquele momento
  function golDoMomento(pico, tempos, gols, momento) {
    if (!gols.length || !tempos.length) return null;
    const perto = pico.filter((_, i) => tempos[i] >= momento - 2 && tempos[i] <= momento + 0.5).sort((a, b) => a - b);
    const onde = perto.length ? perto[Math.floor(perto.length / 2)] : pico[pico.length - 1];
    const g = gols.reduce((a, b) => Math.abs(b - onde) < Math.abs(a - onde) ? b : a);
    let i = 0; while (i < tempos.length - 1 && tempos[i] < momento - ANTES_DO_GOL_S) i++;
    return [g, i];
  }

  function caminho({ W, H, tempos, colunas, lados, nCol }, prop, gols, momento) {
    const largCrop = Math.min(W, Math.round(H * prop[0] / prop[1] / 2) * 2);
    const la = Math.max(2, Math.round(largCrop * nCol / W));
    const n = colunas.length, P = Math.max(1, nCol - la + 1);
    if (n < 2) return { largCrop, tempos: [0], xs: [(W - largCrop) / 2] };
    const massa = colunas.map(c => {   // movimento dentro de cada janela, de 0 a 1 em cada instante
      const v = new Float32Array(P); let s = 0;
      for (let x = 0; x < la; x++) s += c[x];
      v[0] = s; for (let p = 1; p < P; p++) { s += c[p + la - 1] - c[p - 1]; v[p] = s; }
      let mx = 1e-6; for (const a of v) mx = Math.max(mx, a);
      for (let p = 0; p < P; p++) v[p] /= mx;
      return v;
    });
    // programação dinâmica: o caminho com mais movimento que menos se mexe
    let S = Float32Array.from(massa[0]); const volta = [];
    for (let t = 1; t < n; t++) {
      const novo = new Float32Array(P), vt = new Int32Array(P);
      for (let p = 0; p < P; p++) {
        let melhor = -Infinity, arg = 0;
        for (let q = 0; q < P; q++) { const v = S[q] - CUSTO_MOVER * Math.abs(p - q); if (v > melhor) { melhor = v; arg = q; } }
        novo[p] = massa[t][p] + melhor; vt[p] = arg;
      }
      S = novo; volta[t] = vt;
    }
    const trilha = new Int32Array(n); let arg = 0;
    for (let p = 1; p < P; p++) if (S[p] > S[arg]) arg = p;
    trilha[n - 1] = arg;
    for (let t = n - 1; t > 0; t--) trilha[t - 1] = volta[t][trilha[t]];
    const difs = tempos.slice(1).map((t, i) => t - tempos[i]).sort((a, b) => a - b);
    const pt = difs[Math.floor(difs.length / 2)] || 1 / FPS_ANALISE;
    // gol marcado: do começo do lance até o fim, o quadro fica com o gol no meio
    if (lados) lados.length && trilhaDoisLados(lados, nCol, la, P).forEach((v, t) => { trilha[t] = v; });
    const pico = ondeEstaAJogada(colunas, nCol);
    const lance = momento != null ? golDoMomento(pico, tempos, gols, momento) : lanceNoGol(pico, tempos, gols, pt);
    if (lance) { const alvo = Math.min(P - 1, Math.max(0, Math.round(lance[0] * nCol - la / 2))); for (let t = lance[1]; t < n; t++) trilha[t] = alvo; }
    // suavização + limite de velocidade do fim para o começo (o quadro chega antes na jogada)
    const x = Array.from(trilha, v => v * W / nCol);
    const sigma = SUAVIDADE_S / pt, r = Math.floor(3 * sigma), g = []; let gs = 0;
    for (let k = -r; k <= r; k++) { const v = Math.exp(-0.5 * (k / sigma) ** 2); g.push(v); gs += v; }
    const xs = x.map((_, i) => { let s = 0; for (let k = -r; k <= r; k++) s += g[k + r] * x[Math.min(n - 1, Math.max(0, i + k))]; return s / gs; });
    const vmax = VELOCIDADE_MAX * W * pt;
    for (let i = n - 2; i >= 0; i--) xs[i] = xs[i + 1] + Math.max(-vmax, Math.min(vmax, xs[i] - xs[i + 1]));
    return { largCrop, tempos, xs: xs.map(v => Math.min(W - largCrop, Math.max(0, v))), lance };
  }

  function posicao(c, t) {   // posição suave em qualquer instante (sem degraus = sem tremida)
    const { tempos, xs } = c, n = tempos.length;
    if (n < 2 || t <= tempos[0]) return xs[0];
    if (t >= tempos[n - 1]) return xs[n - 1];
    let a = 0, b = n - 1;
    while (b - a > 1) { const m = (a + b) >> 1; if (tempos[m] <= t) a = m; else b = m; }
    return xs[a] + (t - tempos[a]) / (tempos[b] - tempos[a]) * (xs[b] - xs[a]);
  }

  // ---------- gravação: toca recortado uma vez e grava com o gravador do celular ----------
  function tipoGravacao() {
    const tipos = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4;codecs=avc1', 'video/mp4',
                   'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
    return tipos.find(t => MediaRecorder.isTypeSupported(t)) || '';
  }

  async function gravar(video, blob, c, z, formato, tela, inicio, fim, aoProgresso, sinal) {
    const [OW, OH] = FORMATOS[formato].saida;
    tela.width = OW; tela.height = OH;
    const ctx = tela.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    const desenhar = () => ctx.drawImage(video, z.x0 + posicao(c, video.currentTime), z.y0, c.largCrop, z.H, 0, 0, OW, OH);
    const fluxo = tela.captureStream(30);

    // som: 1º jeito: decodifica o áudio do replay e toca junto só para dentro da gravação (o vídeo segue mudo);
    // 2º jeito, se o celular não abrir o áudio assim: pega o som do próprio vídeo (sem sair no alto-falante)
    let somFonte = null, somDoVideo = false, motivoSom = '';
    if (!audioPronto()) motivoSom = 'o som não foi liberado neste celular';
    else {
      const destino = audioCtx.createMediaStreamDestination();
      try {
        const audio = await audioCtx.decodeAudioData(await blob.arrayBuffer());
        somFonte = audioCtx.createBufferSource(); somFonte.buffer = audio; somFonte.connect(destino);
      } catch (e) {
        motivoSom = 'não abriu o áudio do replay (' + (e && e.name || e) + ')';
        try { audioCtx.createMediaElementSource(video).connect(destino); somDoVideo = true; motivoSom = ''; }
        catch (e2) { motivoSom += ' / ' + (e2 && e2.name || e2); }
      }
      if (somFonte || somDoVideo) destino.stream.getAudioTracks().forEach(t => fluxo.addTrack(t));
    }

    const tipo = tipoGravacao();
    const gravador = new MediaRecorder(fluxo, tipo ? { mimeType: tipo, videoBitsPerSecond: 8000000 } : { videoBitsPerSecond: 8000000 });
    const pedacos = [];
    gravador.ondataavailable = e => { if (e.data && e.data.size) pedacos.push(e.data); };
    const parou = new Promise(ok => { gravador.onstop = ok; });

    video.playbackRate = 1;
    video.currentTime = inicio; await esperar(video, 'seeked');
    desenhar();
    let rodando = true, interrompido = false;
    const saiu = () => { if (document.hidden) { interrompido = true; video.pause(); } };   // saiu do app: o vídeo pararia
    document.addEventListener('visibilitychange', saiu);
    let chegou = false;
    const quadro = () => {
      if (!rodando) return;
      if (video.currentTime >= fim) { chegou = true; video.pause(); return; }   // fim do trecho
      desenhar(); aoProgresso((video.currentTime - inicio) / (fim - inicio));
      if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(quadro); else requestAnimationFrame(quadro);
    };
    try {
      if (somDoVideo) video.muted = false;   // o som vai só para a gravação (o vídeo está ligado ao áudio do app)
      gravador.start(500);
      await video.play();
      if (somFonte) somFonte.start(0, video.currentTime, fim - video.currentTime);
      quadro();
      await new Promise(ok => {
        const fim = () => { video.removeEventListener('ended', fim); video.removeEventListener('pause', fim); ok(); };
        video.addEventListener('ended', fim); video.addEventListener('pause', fim);
        sinal.addEventListener('abort', () => { video.pause(); });
      });
    } finally {
      rodando = false; desenhar();
      document.removeEventListener('visibilitychange', saiu);
      try { if (somFonte) somFonte.stop(); } catch (e) { }
      if (gravador.state !== 'inactive') gravador.stop();
      await parou;
      fluxo.getTracks().forEach(t => t.stop());
      video.muted = true;
    }
    if (sinal.aborted) throw new DOMException('cancelado', 'AbortError');
    if (video.ended) chegou = true;
    if (interrompido || !chegou) throw new Error('a gravação parou porque o app saiu da tela. Gere de novo e espere terminar');
    const mime = (tipo || 'video/webm').split(';')[0];
    return { blob: new Blob(pedacos, { type: mime }), som: !!(somFonte || somDoVideo), motivoSom };
  }

  // ---------- tudo junto ----------
  // Trecho de 8 s em volta do momento marcado (6 s antes, 2 s depois); vídeo curto: ele inteiro
  function trecho(duracao, momento) {
    if (duracao <= DURACAO + 0.5 || momento == null) return [0, Math.min(duracao, momento == null ? duracao : DURACAO)];
    let inicio = Math.max(0, momento - ANTES);
    const fim = Math.min(duracao, inicio + DURACAO);
    inicio = Math.max(0, fim - DURACAO);
    return [inicio, fim];
  }

  const suportado = () => !!window.MediaRecorder && !!HTMLCanvasElement.prototype.captureStream;

  // blob: o replay já baixado. momento: segundo do gol (ou null). etapas: aoEtapa('analisando'|'gravando', fração)
  async function gerar({ blob, formato, gols, momento, esporte: nomeEsporte, rede, tela, aoEtapa, sinal }) {
    const cfg = esporte(nomeEsporte);
    if (!suportado()) throw new Error('este celular não grava vídeo pelo app. Atualize o navegador / Android System WebView');
    let video = null;
    try {
      video = await abrirVideo(blob);
      const [inicio, fim] = trecho(video.duration, momento);
      // zoom: o pedaço do centro da imagem que vale (como uma lente mais fechada)
      const VW = video.videoWidth, VH = video.videoHeight;
      const z = { W: Math.round(VW / cfg.zoom / 2) * 2, H: Math.round(VH / cfg.zoom / 2) * 2 };
      z.x0 = Math.floor((VW - z.W) / 4) * 2; z.y0 = Math.floor((VH - z.H) / 4) * 2;
      const divisao = cfg.doisLados ? (rede > 0 && rede < 1 ? rede : cfg.rede) : null;
      const bruto = await analisar(video, inicio, fim, [z.y0 / VH, (z.y0 + z.H) / VH], divisao, f => aoEtapa('analisando', f), sinal);
      const a0 = Math.round(z.x0 * LARGURA_ANALISE / VW), nCol = Math.round(z.W * LARGURA_ANALISE / VW);
      const corta = c => c.subarray(a0, a0 + nCol);
      const dados = { W: z.W, H: z.H, tempos: bruto.tempos, nCol, colunas: bruto.colunas.map(corta),
                      lados: bruto.lados ? bruto.lados.map(([f, p]) => [corta(f), corta(p)]) : null };
      const golsZ = cfg.gols ? (gols || []).map(g => (g * VW - z.x0) / z.W).filter(g => g >= 0 && g <= 1) : [];
      const c = caminho(dados, FORMATOS[formato].prop, golsZ, momento);
      aoEtapa('gravando', 0);
      const g = await gravar(video, blob, c, z, formato, tela, inicio, fim, f => aoEtapa('gravando', f), sinal);
      return { blob: g.blob, extensao: g.blob.type.includes('mp4') ? 'mp4' : 'webm', lance: !!c.lance, som: g.som, motivoSom: g.motivoSom };
    } finally { fecharVideo(video); }
  }

  // Gols da planilha: "0.24;0.76" → [0.24, 0.76]
  function lerGols(texto) {
    return String(texto || '').replace(/,/g, '.').split(/[;\s]+/).map(Number).filter(g => g > 0 && g < 1).slice(0, 2);
  }

  // ---------- entregar o vídeo pronto: app Android (ponte Java) ou navegador ----------
  async function entregar(blob, nome, compartilhar) {
    if (window.App && typeof App.arquivoInicio === 'function') {
      // Android: manda em pedaços para o app gravar o arquivo (a ponte só aceita texto)
      App.arquivoInicio(nome, blob.type);
      const PEDACO = 768 * 1024;
      for (let i = 0; i < blob.size; i += PEDACO) {
        const b64 = await new Promise((ok, erro) => {
          const r = new FileReader();
          r.onload = () => ok(String(r.result).split(',')[1] || '');
          r.onerror = () => erro(r.error);
          r.readAsDataURL(blob.slice(i, i + PEDACO));
        });
        if (!App.arquivoParte(b64)) throw new Error('não consegui gravar o arquivo no celular');
      }
      const r = App.arquivoConcluir(!!compartilhar);
      if (r) throw new Error(r);
      return compartilhar ? '' : 'Vídeo salvo na galeria (pasta ReplayPro).';
    }
    const arquivo = new File([blob], nome, { type: blob.type });
    if (navigator.canShare && navigator.canShare({ files: [arquivo] })) {   // iPhone: a folha tem "Salvar vídeo"
      try { await navigator.share({ files: [arquivo] }); } catch (e) { if (!e || e.name !== 'AbortError') throw e; }
      return '';
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = nome;
    document.body.appendChild(a); a.click(); a.remove();
    return 'Vídeo baixado.';
  }

  return { FORMATOS, DURACAO, ESPORTES, esporte, prepararAudio, audioPronto, suportado, baixar, trecho, gerar, lerGols, entregar };
})();
