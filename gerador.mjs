// Geração de imagem LOCAL com o ComfyUI (placa AMD) e o modelo Z-Image Turbo.
// O bot liga o ComfyUI quando precisa, manda o pedido pela API local (só 127.0.0.1) e, depois de
// alguns minutos sem uso, pede para ele liberar a VRAM (para não atrapalhar jogo/uso do PC).
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

let cfg = null;
let processo = null;
let iniciando = null;
let timerOcioso = null;
let fila = Promise.resolve();

/**
 * @param {object} c
 * @param {string} c.pasta pasta do ComfyUI portátil (a que tem run_amd_gpu.bat / python_embeded)
 * @param {number} [c.porta]
 * @param {number} [c.liberarVramMin] minutos sem uso até liberar a VRAM
 * @param {(msg: string) => void} [c.log]
 */
export function configurarGerador(c) {
  // dispositivoTexto "cpu": o codificador de texto (7,6 GB) roda no processador e o modelo de imagem
  // fica fixo na placa (16 GB não comportam os dois; trocar a cada pedido é lento e derrubava o ComfyUI).
  cfg = { porta: 8188, liberarVramMin: 5, argsExtras: ['--disable-pinned-memory'],
    // Liga os kernels de flash attention da AMD (AOTriton) que já vêm no PyTorch: ~5x mais rápido na RX 9060 XT.
    env: { TORCH_ROCM_AOTRITON_ENABLE_EXPERIMENTAL: '1' }, passos: 8, dispositivoTexto: 'cpu', log: () => {}, ...c };
  return disponivel();
}

export function disponivel() {
  if (!cfg?.pasta) return false;
  const comfy = path.join(cfg.pasta, 'ComfyUI');
  const necessarios = [
    path.join(comfy, 'main.py'),
    path.join(cfg.pasta, 'python_embeded', 'python.exe'),
    path.join(comfy, 'models', 'diffusion_models', 'z_image_turbo_bf16.safetensors'),
    path.join(comfy, 'models', 'text_encoders', 'qwen_3_4b.safetensors'),
    path.join(comfy, 'models', 'vae', 'ae.safetensors'),
  ];
  return necessarios.every((f) => fs.existsSync(f));
}

const base = () => `http://127.0.0.1:${cfg.porta}`;

async function estaNoAr() {
  try {
    const r = await fetch(`${base()}/system_stats`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch {
    return false;
  }
}

/** Liga o ComfyUI (se ainda não estiver no ar) e espera ele responder. */
async function garantirNoAr() {
  if (await estaNoAr()) return;
  if (iniciando) return iniciando;
  iniciando = (async () => {
    cfg.log('Ligando o ComfyUI...');
    const py = path.join(cfg.pasta, 'python_embeded', 'python.exe');
    processo = spawn(py, ['-s', path.join('ComfyUI', 'main.py'), '--listen', '127.0.0.1', '--port', String(cfg.porta), '--disable-auto-launch', ...cfg.argsExtras], {
      cwd: cfg.pasta,
      env: { ...process.env, ...cfg.env },
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let erro = '';
    processo.stderr.on('data', (d) => { erro = (erro + d).slice(-2000); });
    processo.on('exit', (code) => {
      const motivo = erro.split('\n').map((l) => l.trim()).filter((l) => /error|exception|fatal|Traceback/i.test(l)).slice(-3).join(' | ');
      cfg.log(`ComfyUI fechou (código ${code})${motivo ? `: ${motivo.slice(0, 400)}` : ''}.`);
      processo = null;
    });
    const limite = Date.now() + 3 * 60_000;
    while (Date.now() < limite) {
      if (await estaNoAr()) { cfg.log('ComfyUI no ar.'); return; }
      if (!processo) throw new Error(`ComfyUI não subiu: ${erro.split('\n').filter(Boolean).pop() || 'sem detalhes'}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error('ComfyUI demorou demais para ligar');
  })().finally(() => { iniciando = null; });
  return iniciando;
}

function agendarLiberacao() {
  clearTimeout(timerOcioso);
  timerOcioso = setTimeout(async () => {
    try {
      await fetch(`${base()}/free`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ unload_models: true, free_memory: true }),
      });
      cfg.log('ComfyUI: VRAM liberada (sem uso).');
    } catch { /* já estava fechado */ }
  }, cfg.liberarVramMin * 60_000);
  timerOcioso.unref?.();
}

// Workflow (formato API) do Z-Image Turbo, igual ao template oficial do ComfyUI.
function workflow(prompt, { largura, altura, semente, passos }) {
  return {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: 'z_image_turbo_bf16.safetensors', weight_dtype: 'default' } },
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen_3_4b.safetensors', type: 'lumina2', device: cfg.dispositivoTexto } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: 'ae.safetensors' } },
    '4': { class_type: 'ModelSamplingAuraFlow', inputs: { model: ['1', 0], shift: 3 } },
    '5': { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 0], text: prompt } },
    '6': { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['5', 0] } },
    '7': { class_type: 'EmptySD3LatentImage', inputs: { width: largura, height: altura, batch_size: 1 } },
    '8': {
      class_type: 'KSampler',
      inputs: {
        model: ['4', 0], positive: ['5', 0], negative: ['6', 0], latent_image: ['7', 0],
        seed: semente, steps: passos, cfg: 1, sampler_name: 'res_multistep', scheduler: 'simple', denoise: 1,
      },
    },
    // Decodificação em blocos: gasta pouca VRAM, então o modelo não precisa sair da placa (era aí que o
    // ComfyUI caía no Windows/ROCm).
    '9': { class_type: 'VAEDecodeTiled', inputs: { samples: ['8', 0], vae: ['3', 0], tile_size: 512, overlap: 64, temporal_size: 64, temporal_overlap: 8 } },
    '10': { class_type: 'SaveImage', inputs: { images: ['9', 0], filename_prefix: 'bot_gabreu' } },
  };
}

const FORMATOS = { quadrado: [1024, 1024], retrato: [832, 1216], paisagem: [1216, 832] };

/**
 * Gera uma imagem e devolve o PNG (Buffer). Um pedido por vez.
 * @param {string} prompt descrição da imagem (de preferência em inglês, bem detalhada)
 * @param {{formato?: 'quadrado'|'retrato'|'paisagem'}} [opcoes]
 */
export function gerarImagem(prompt, { formato = 'quadrado', passos } = {}) {
  const tarefa = fila.then(async () => {
    try {
      return await gerarAgora(prompt, formato, passos || cfg.passos);
    } catch (e) {
      // Se o ComfyUI caiu no meio (acontece no ROCm do Windows), religa e tenta mais uma vez.
      if (await estaNoAr()) throw e;
      cfg.log(`ComfyUI caiu (${e.message}); religando e tentando de novo...`);
      return gerarAgora(prompt, formato, passos || cfg.passos);
    }
  });
  fila = tarefa.catch(() => {});
  return tarefa;
}

async function gerarAgora(prompt, formato, passos) {
  if (!disponivel()) throw new Error('gerador de imagem não instalado');
  await garantirNoAr();
  clearTimeout(timerOcioso);
  const [largura, altura] = FORMATOS[formato] || FORMATOS.quadrado;
  const semente = crypto.randomInt(0, 2 ** 31);
  const inicio = Date.now();

  const r = await fetch(`${base()}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow(prompt, { largura, altura, semente, passos }), client_id: 'bot-gabreu' }),
  });
  const enviado = await r.json();
  if (!r.ok || !enviado.prompt_id) throw new Error(`ComfyUI recusou: ${JSON.stringify(enviado.error || enviado).slice(0, 300)}`);

  try {
    const limite = Date.now() + 5 * 60_000;
    while (Date.now() < limite) {
      await new Promise((res) => setTimeout(res, 1500));
      const h = await (await fetch(`${base()}/history/${enviado.prompt_id}`)).json();
      const item = h[enviado.prompt_id];
      if (!item) continue;
      if (item.status?.status_str === 'error') {
        const msg = item.status.messages?.find((m) => m[0] === 'execution_error')?.[1]?.exception_message;
        throw new Error(`erro ao gerar: ${msg || 'desconhecido'}`);
      }
      const img = Object.values(item.outputs || {}).flatMap((o) => o.images || [])[0];
      if (!img) continue;
      const q = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder || '', type: img.type || 'output' });
      const png = Buffer.from(await (await fetch(`${base()}/view?${q}`)).arrayBuffer());
      // Não guarda as imagens geradas no disco do PC.
      try { fs.rmSync(path.join(cfg.pasta, 'ComfyUI', 'output', img.subfolder || '', img.filename), { force: true }); } catch { /* ok */ }
      cfg.log(`Imagem gerada em ${((Date.now() - inicio) / 1000).toFixed(0)}s (${largura}x${altura}).`);
      return png;
    }
    throw new Error('demorou demais para gerar');
  } finally {
    agendarLiberacao();
  }
}

/** Desliga o ComfyUI que o bot ligou (ao fechar o bot). */
export function desligarGerador() {
  clearTimeout(timerOcioso);
  if (processo) { try { processo.kill(); } catch { /* ok */ } }
}
