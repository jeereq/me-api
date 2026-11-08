import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { configCloudinary, ErreurCloudinary, raisonCloudinary } from '../src/services/justificatifs/cloudinary.js';
import { diagnosticFichiers } from '../src/services/justificatifs/diagnostic.js';
import { estFichier } from '../src/utils/formulaire.js';

describe('envoi de fichiers', () => {
  it('lit CLOUDINARY_URL même collée avec son nom, des guillemets ou des espaces', () => {
    const attendu = { cle: '123', secret: 'abc', cloud: 'moncompte' };
    for (const v of ['cloudinary://123:abc@moncompte', ' CLOUDINARY_URL=cloudinary://123:abc@moncompte ', '"cloudinary://123:abc@moncompte"', "CLOUDINARY_URL = 'cloudinary://123:abc@moncompte'", '<cloudinary://123:abc@moncompte>'])
      assert.deepEqual(configCloudinary({ CLOUDINARY_URL: v }), attendu, v);
    assert.deepEqual(configCloudinary({ CLOUDINARY_CLOUD_NAME: ' "moncompte" ', CLOUDINARY_API_KEY: '123', CLOUDINARY_API_SECRET: 'CLOUDINARY_API_SECRET=abc' }), attendu);
    assert.equal(configCloudinary({ CLOUDINARY_URL: 'pas une adresse' }), null);
  });

  it('dit pourquoi Cloudinary refuse', () => {
    assert.match(raisonCloudinary(new ErreurCloudinary(401, 'Invalid Signature')), /clé Cloudinary du serveur est refusée/);
    assert.match(raisonCloudinary(new ErreurCloudinary(401, 'Unknown API key 123')), /clé/);
    assert.match(raisonCloudinary(new ErreurCloudinary(404, 'Invalid cloud_name moncompte')), /nom du compte/);
    assert.match(raisonCloudinary(new ErreurCloudinary(420, 'Rate Limit Exceeded')), /limite/);
    assert.match(raisonCloudinary(new ErreurCloudinary(400, 'Invalid image file')), /JPEG ou un PDF/);
    assert.match(raisonCloudinary(new Error('Cloudinary est injoignable.')), /^Cloudinary est injoignable$/);
  });

  it('reconnaît un fichier sans dépendre de la classe File', () => {
    assert.equal(estFichier(new File(['x'], 'a.txt')), true);
    assert.equal(estFichier({ name: 'a', size: 1, arrayBuffer: async () => new ArrayBuffer(1) }), true);
    assert.equal(estFichier('texte'), false);
    assert.equal(estFichier(null), false);
  });

  it('le diagnostic s’arrête à la configuration absente', async () => {
    const avant = { ...process.env };
    delete process.env.CLOUDINARY_URL;
    delete process.env.CLOUDINARY_CLOUD_NAME;
    try {
      const d = await diagnosticFichiers();
      assert.equal(d.ok, false);
      assert.deepEqual(d.etapes.map((e) => [e.etape, e.ok]), [['Lecture des fichiers reçus', true], ['Configuration Cloudinary', false]]);
    } finally {
      Object.assign(process.env, avant);
    }
  });
});

describe('signature Cloudinary', () => {
  it('réessaie en SHA-256 quand le compte refuse la signature SHA-1', async () => {
    const { Cloudinary } = await import('../src/services/justificatifs/cloudinary.js');
    const vus: string[] = [];
    const avant = globalThis.fetch;
    globalThis.fetch = (async (_url: string, o: { body: FormData }) => {
      const algo = o.body.get('signature_algorithm') ? 'sha256' : 'sha1';
      vus.push(algo);
      if (algo === 'sha1') return new Response(JSON.stringify({ error: { message: 'Invalid Signature abc. String to sign - folder=x&timestamp=1' } }), { status: 401 });
      return new Response(JSON.stringify({ public_id: 'x/p', secure_url: 'https://res/x', resource_type: 'image', format: 'png', bytes: 3 }), { status: 200 });
    }) as typeof fetch;
    try {
      const d = await Cloudinary.deposer({ cloud: 'c', cle: 'k', secret: 's' }, { contenu: new Blob(['abc']), nom: 'p.png' }, 'x', 'image');
      assert.equal(d.publicId, 'x/p');
      assert.deepEqual(vus, ['sha1', 'sha256']);
    } finally {
      globalThis.fetch = avant;
    }
  });
  it('le diagnostic montre la réponse exacte de Cloudinary', () => {
    assert.match(raisonCloudinary(new ErreurCloudinary(401, 'Invalid api_key 123'), true), /réponse de Cloudinary : « Invalid api_key 123 »/);
  });
});

describe('preset non signé', () => {
  it('se configure avec le nom du compte et le preset, sans secret', () => {
    assert.deepEqual(configCloudinary({ CLOUDINARY_CLOUD_NAME: 'moncompte', CLOUDINARY_UPLOAD_PRESET: ' "me-api" ' }), { cloud: 'moncompte', cle: '', secret: '', preset: 'me-api' });
    // Avec une CLOUDINARY_URL déjà là : le nom du compte en vient, le preset passe devant pour l'envoi.
    assert.deepEqual(configCloudinary({ CLOUDINARY_URL: 'cloudinary://1:x@moncompte', CLOUDINARY_UPLOAD_PRESET: 'me-api' }), { cloud: 'moncompte', cle: '1', secret: 'x', preset: 'me-api' });
    assert.equal(configCloudinary({ CLOUDINARY_UPLOAD_PRESET: 'me-api' }), null);
  });

  it('envoie le fichier avec le preset, sans clé ni signature, et ne tente pas de supprimer', async () => {
    const { Cloudinary } = await import('../src/services/justificatifs/cloudinary.js');
    const corps: FormData[] = [];
    const avant = globalThis.fetch;
    globalThis.fetch = (async (_url: string, o: { body: FormData }) => {
      corps.push(o.body);
      return new Response(JSON.stringify({ public_id: 'me/x/abc', secure_url: 'https://res/x', resource_type: 'image', type: 'upload', format: 'jpg', bytes: 3 }), { status: 200 });
    }) as typeof fetch;
    try {
      const c = { cloud: 'moncompte', cle: '', secret: '', preset: 'me-api' };
      const d = await Cloudinary.deposer(c, { contenu: new Blob(['abc']), nom: 'r.jpg' }, 'me/x', 'image');
      assert.equal(d.acces, 'upload');
      assert.equal(corps[0].get('upload_preset'), 'me-api');
      assert.equal(corps[0].get('folder'), 'me/x');
      assert.equal(corps[0].get('signature'), null);
      assert.equal(corps[0].get('api_key'), null);
      await assert.rejects(Cloudinary.supprimer(c, d.publicId, 'image'), /sans clé ni secret/);
      assert.equal(corps.length, 1);
    } finally {
      globalThis.fetch = avant;
    }
  });

  it('dit clairement quand le preset n’est pas non signé ou n’existe pas', () => {
    assert.match(raisonCloudinary(new ErreurCloudinary(400, 'Upload preset must be whitelisted for unsigned uploads')), /mode « Unsigned »/);
    assert.match(raisonCloudinary(new ErreurCloudinary(400, 'Upload preset not found')), /introuvable/);
  });
});
