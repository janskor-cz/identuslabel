const { MongoClient } = require('/opt/project_identuslabel/idl-wallet/node_modules/mongodb');
const c = new MongoClient('mongodb://admin:admin@localhost:27017/mediator?authSource=admin');

const DID_JL3 = 'did:peer:2.Ez6LSjL3RabbMAdSDhxTB8SJddfSUfa7LAyxrPReZT4VNR9XQ.Vz6MkwTif16SrDsvxamgHYjaDFRo87ESQC3eZAQycstXCV2xi.SW10';
const DID_ST3 = 'did:peer:2.Ez6LSt3STe2E5zgLZUW5agZxhE8VZehqLD9XYwFcc56qQBXks.Vz6Mkt3qnhwX658S4tZ28PMby8ZMaaFoZSY8DBFrcnUS3Xne6.SeyJ0IjoiZG0iLCJzIjp7InVyaSI6ImRpZDpwZWVyOjIuRXo2TFNnaHdTRTQzN3duREUxcHQzWDZoVkRVUXpTanNIemlucFgzWEZ2TWpSQW03eS5WejZNa2hoMWU1Q0VZWXE2SkJVY1RaNkNwMnJhbkNXUnJ2N1lheDNMZTRONTlSNmRkLlNleUowSWpvaVpHMGlMQ0p6SWpwN0luVnlhU0k2SW1oMGRIQnpPaTh2YVdSbGJuUjFjMnhoWW1Wc0xtTjZMMjFsWkdsaGRHOXlJaXdpWVNJNld5SmthV1JqYjIxdEwzWXlJbDE5ZlEiLCJyIjpbXSwiYSI6W119fQ';

c.connect().then(async () => {
  const col = c.db('mediator').collection('user.account');
  const r = await col.updateOne(
    { did: /Ez6LSpC7/ },
    { $addToSet: { alias: { $each: [DID_JL3, DID_ST3] } } }
  );
  console.log('Matched:', r.matchedCount, 'Modified:', r.modifiedCount);

  const acc = await col.findOne({ did: /Ez6LSpC7/ });
  console.log('Has Ez6LSjL3:', acc.alias.some(a => a.includes('Ez6LSjL3')));
  console.log('Has Ez6LSt3:', acc.alias.some(a => a.includes('Ez6LSt3')));
  console.log('Total alias count:', acc.alias.length);
  await c.close();
});
