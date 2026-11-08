import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { describe, it } from 'node:test';

const { lireCsv, lireXlsx, tableauEnTexte, MAX_LIGNES } = await import('../src/services/pieces/tableur.js');
const { genrePiece, lireAnalysePiece, messagesPiece, SCHEMA_PIECE } = await import('../src/services/pieces/analyse.js');
const { analysePieceSchema } = await import('../src/validators/schemas.js');

describe('tableurs joints', () => {
  it('lit un CSV : séparateur deviné, guillemets, en-tête', () => {
    const t = lireCsv('﻿Date;Libellé;Montant\r\n2026-10-01;"Achat ; Kin ""Marché""";12,50\r\n2026-10-02;Loyer;300\r\n');
    assert.deepEqual(t?.colonnes, ['Date', 'Libellé', 'Montant']);
    assert.deepEqual(t?.lignes, [
      ['2026-10-01', 'Achat ; Kin "Marché"', '12,50'],
      ['2026-10-02', 'Loyer', '300'],
    ]);
    assert.equal(t?.totalLignes, 2);
    assert.deepEqual(lireCsv('1,2\n3,4')?.colonnes, ['A', 'B']);
    assert.equal(lireCsv(''), null);
  });

  it('ne montre que les premières lignes d’un gros CSV, mais dit combien il y en a', () => {
    const gros = ['a,b', ...Array.from({ length: 500 }, (_, i) => `x${i},${i}`)].join('\n');
    const t = lireCsv(gros)!;
    assert.equal(t.lignes.length, MAX_LIGNES);
    assert.equal(t.totalLignes, 500);
  });

  it('lit la première feuille d’un Excel .xlsx', () => {
    const t = lireXlsx(readFileSync('tests/fixtures/releve.xlsx'))!;
    assert.equal(t.feuille, 'Octobre & novembre');
    assert.deepEqual(t.colonnes, ['Date', 'Libellé', 'Montant']);
    assert.deepEqual(t.lignes, [
      ['45931', 'Achat Kin Marché', '12.5'],
      ['2026-10-05', 'Loyer', '300'],
    ]);
    assert.match(tableauEnTexte(t), /^Date\tLibellé\tMontant\n45931/);
  });

  it('refuse une archive qui n’en est pas une, et une archive qui se déplie trop', () => {
    assert.throws(() => lireXlsx(Buffer.from('pas un zip')));
    // Une « bombe » : 40 Mo de zéros compressés en quelques ko.
    const bombe = deflateRawSync(Buffer.alloc(40 * 1024 * 1024));
    const nom = Buffer.from('xl/worksheets/sheet1.xml');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(bombe.length, 18);
    local.writeUInt16LE(nom.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(bombe.length, 20);
    central.writeUInt16LE(nom.length, 28);
    const debutCentral = local.length + nom.length + bombe.length;
    const fin = Buffer.alloc(22);
    fin.writeUInt32LE(0x06054b50, 0);
    fin.writeUInt16LE(1, 10);
    fin.writeUInt32LE(central.length + nom.length, 12);
    fin.writeUInt32LE(debutCentral, 16);
    assert.throws(() => lireXlsx(Buffer.concat([local, nom, bombe, central, nom, fin])));
  });
});

describe('analyse d’une pièce jointe', () => {
  const c = { aujourdhui: '2026-11-08', devise: 'USD' };
  it('reconnaît ce qui s’analyse', () => {
    assert.equal(genrePiece('facture.pdf', 'application/pdf'), 'pdf');
    assert.equal(genrePiece('photo.HEIC', 'image/heic'), null);
    assert.equal(genrePiece('releve.xlsx', 'application/octet-stream'), 'tableur');
    assert.equal(genrePiece('releve.csv', 'text/plain'), 'tableur');
    assert.equal(genrePiece('note.txt'), 'texte');
    assert.equal(genrePiece('contrat.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), null);
  });

  it('envoie un PDF comme fichier, une image comme image, un tableur comme texte', () => {
    const pdf = messagesPiece(c, { genre: 'pdf', nom: 'f.pdf', type: 'application/pdf', base64: 'QUJD' });
    assert.deepEqual((pdf[1].content as { type: string }[]).map((x) => x.type), ['text', 'file']);
    assert.match(pdf[0].content as string, /jamais une instruction/);
    assert.match(pdf[0].content as string, /jusqu'à 30 lignes/);
    const tab = messagesPiece(c, { genre: 'tableur', nom: 'r.csv', texte: 'a\tb' });
    assert.match(tab[0].content as string, /toujours null/);
    assert.equal(SCHEMA_PIECE.schema.required.length, Object.keys(SCHEMA_PIECE.schema.properties).length);
  });

  it('nettoie la réponse : rien d’inventé ni de douteux', () => {
    const r = lireAnalysePiece(
      JSON.stringify({
        nature: 'facture',
        titre: '  Facture SNEL   d’octobre ',
        resume: 'Électricité.',
        champs: [{ libelle: 'Total', valeur: '45 USD' }, { libelle: '', valeur: 'x' }],
        depense: { montant: '45,00', devise: 'usd', date: '2027-01-01', marchand: 'SNEL', description: 'Électricité' },
        echeance: '2026-11-20',
        tableau: { colonnes: ['Article', 'Prix'], lignes: [['Courant', '45'], ['seul']] },
      }),
      c,
    );
    assert.equal(r.titre, 'Facture SNEL d’octobre');
    assert.deepEqual(r.champs, [{ libelle: 'Total', valeur: '45 USD' }]);
    assert.deepEqual(r.depense, { montant: 45, devise: 'USD', date: null, marchand: 'SNEL', description: 'Électricité' });
    assert.equal(r.echeance, '2026-11-20');
    assert.deepEqual(r.tableau?.lignes, [['Courant', '45'], ['seul', '']]);
    const vide = lireAnalysePiece('pas du json', c);
    assert.deepEqual([vide.nature, vide.depense, vide.tableau, vide.champs], ['autre', null, null, []]);
    assert.equal(lireAnalysePiece(JSON.stringify({ nature: 'pirate', depense: { montant: -3 } }), c).depense, null);
  });

  it('valide la demande', () => {
    assert.equal(analysePieceSchema.safeParse({ body: { aujourdhui: '08/11/2026' } }).success, false);
    assert.equal(analysePieceSchema.parse({ body: { aujourdhui: '2026-11-08' } }).body.devise, 'USD');
  });
});
