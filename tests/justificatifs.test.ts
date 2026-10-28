import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, describe, it } from 'node:test';

import { Cloudinary, configCloudinary, signer } from '../src/services/justificatifs/cloudinary.js';
import { dossier, estReference, nomPropre, typeFichier, vignette } from '../src/services/justificatifs/fichiers.js';

const fetchOrigine = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = fetchOrigine;
});

describe('configuration Cloudinary', () => {
  it('lit CLOUDINARY_URL telle que donnée par le tableau de bord', () => {
    assert.deepEqual(configCloudinary({ CLOUDINARY_URL: 'cloudinary://123456:abc-DEF_9@mon-cloud' }), { cle: '123456', secret: 'abc-DEF_9', cloud: 'mon-cloud' });
  });
  it('accepte aussi les trois variables séparées', () => {
    assert.deepEqual(configCloudinary({ CLOUDINARY_CLOUD_NAME: 'c', CLOUDINARY_API_KEY: 'k', CLOUDINARY_API_SECRET: 's' }), { cloud: 'c', cle: 'k', secret: 's' });
  });
  it('reste éteint tant qu’il manque quelque chose', () => {
    assert.equal(configCloudinary({}), null);
    assert.equal(configCloudinary({ CLOUDINARY_CLOUD_NAME: 'c', CLOUDINARY_API_KEY: 'k' }), null);
  });
});

describe('signature Cloudinary', () => {
  it('suit la documentation : paramètres triés, secret collé, SHA-1', () => {
    // Exemple de la documentation Cloudinary (« Generating authentication signatures »).
    const attendu = createHash('sha1').update('eager=w_400,h_300,c_pad|w_260,h_200,c_crop&public_id=sample_image&timestamp=1315060510abcd').digest('hex');
    assert.equal(signer({ timestamp: 1315060510, public_id: 'sample_image', eager: 'w_400,h_300,c_pad|w_260,h_200,c_crop' }, 'abcd'), attendu);
  });
});

describe('dépôt et suppression', () => {
  const c = { cloud: 'cloud', cle: 'cle', secret: 'secret' };

  it('envoie le fichier signé dans le bon dossier et relit la réponse', async () => {
    let vu: { url: string; form: FormData } | null = null;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      vu = { url, form: init.body as FormData };
      return new Response(JSON.stringify({ public_id: 'me/justificatifs/u1/abc', secure_url: 'https://res.cloudinary.com/cloud/image/upload/v1/me/justificatifs/u1/abc.pdf', resource_type: 'image', format: 'pdf', bytes: 2048, pages: 2 }), { status: 200 });
    }) as typeof fetch;
    const d = await Cloudinary.deposer(c, { contenu: new Blob(['%PDF-1.4']), nom: 'facture.pdf' }, 'me/justificatifs/u1', 'image');
    assert.equal(vu!.url, 'https://api.cloudinary.com/v1_1/cloud/image/upload');
    const f = vu!.form;
    assert.equal(f.get('folder'), 'me/justificatifs/u1');
    assert.equal(f.get('api_key'), 'cle');
    assert.equal(f.get('signature'), signer({ folder: 'me/justificatifs/u1', timestamp: Number(f.get('timestamp')) }, 'secret'));
    assert.ok(f.get('file') instanceof Blob);
    assert.deepEqual(d, { publicId: 'me/justificatifs/u1/abc', url: 'https://res.cloudinary.com/cloud/image/upload/v1/me/justificatifs/u1/abc.pdf', genre: 'image', format: 'pdf', octets: 2048, pages: 2 });
  });

  it('remonte le message de Cloudinary quand il refuse', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: 'Invalid Signature' } }), { status: 401 })) as unknown as typeof fetch;
    await assert.rejects(Cloudinary.deposer(c, { contenu: new Blob(['x']), nom: 'a.jpg' }, 'd', 'image'), /Invalid Signature/);
  });

  it('considère un fichier déjà absent comme supprimé', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ result: 'not found' }), { status: 200 })) as unknown as typeof fetch;
    await Cloudinary.supprimer(c, 'x', 'image');
    globalThis.fetch = (async () => new Response(JSON.stringify({ result: 'error' }), { status: 200 })) as unknown as typeof fetch;
    await assert.rejects(Cloudinary.supprimer(c, 'x', 'image'));
  });
});

describe('fichiers acceptés', () => {
  it('prend les photos et les PDF, refuse le reste', () => {
    assert.equal(typeFichier('image/jpeg', 'recu.jpg')?.sorte, 'image');
    assert.equal(typeFichier('image/heic', 'IMG_0001.HEIC')?.sorte, 'image');
    assert.equal(typeFichier('application/pdf', 'facture.pdf')?.sorte, 'pdf');
    assert.equal(typeFichier('text/html', 'page.html'), null);
    assert.equal(typeFichier('application/zip', 'a.zip'), null);
  });
  it('devine le type par l’extension quand le téléphone ne le donne pas', () => {
    assert.equal(typeFichier('application/octet-stream', 'Facture EDF.PDF')?.mime, 'application/pdf');
    assert.equal(typeFichier('', 'photo.jpeg')?.mime, 'image/jpeg');
  });
  it('nettoie le nom affiché', () => {
    assert.equal(nomPropre('C:\\Users\\moi\\reçu\u0007.jpg', 'image'), 'reçu.jpg');
    assert.equal(nomPropre('', 'pdf'), 'facture.pdf');
    assert.equal(nomPropre('a'.repeat(300), 'image').length, 120);
  });
});

describe('vignettes et dossiers', () => {
  it('fait la vignette de la première page d’un PDF en JPEG', () => {
    assert.equal(vignette('https://res.cloudinary.com/c/image/upload/v17/me/justificatifs/u1/abc.pdf'), 'https://res.cloudinary.com/c/image/upload/c_fill,w_240,h_240,pg_1,f_jpg,q_auto/v17/me/justificatifs/u1/abc.jpg');
    assert.equal(vignette('https://res.cloudinary.com/c/raw/upload/v17/abc.pdf'), undefined);
  });
  it('range par compte, ou par équipe', () => {
    assert.equal(dossier('u1', null, 'me/justificatifs'), 'me/justificatifs/u1');
    assert.equal(dossier('u1', 'e9', 'me/justificatifs/'), 'me/justificatifs/equipe-e9');
  });
  it('retrouve un justificatif dans les dépenses de l’espace, et seulement lui', () => {
    const data = { finances: { depenses: [{ id: 'd1', justificatifs: [{ id: 'me/justificatifs/u1/abc', nom: 'a.jpg' }] }] } };
    assert.equal(estReference(data, 'me/justificatifs/u1/abc'), true);
    assert.equal(estReference(data, 'me/justificatifs/u1/ab'), false);
    assert.equal(estReference(null, 'x'), false);
  });
});
