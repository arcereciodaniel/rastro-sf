'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const handler=require('../api/fx.js');

async function invoke(date, upstream, method='GET'){
 const oldFetch=global.fetch;
 global.fetch=async url=>{
  const result=await upstream(String(url));
  if(result instanceof Error)throw result;
  return {ok:result.status===undefined||result.status===200,status:result.status||200,json:async()=>result.body??result};
 };
 const res={
  statusCode:200,body:null,headers:{},
  setHeader(k,v){this.headers[k]=v;return this;},
  status(n){this.statusCode=n;return this;},
  json(value){this.body=value;return this;}
 };
 try{await handler({method,query:{date}},res);}finally{global.fetch=oldFetch;}
 return res;
}

test('obtiene compra y venta históricas de Hacienda',async()=>{
 const res=await invoke('2026-11-04',async()=>({
  compra:[{fecha:'2026-11-04',valor:447.1}],
  venta:[{fecha:'2026-11-04',valor:452.2}]
 }));
 assert.equal(res.statusCode,200);
 assert.equal(res.body.official,true);
 assert.equal(res.body.buy,447.1);
 assert.equal(res.body.sell,452.2);
});
test('en fines de semana usa la última publicación anterior',async()=>{
 const res=await invoke('2026-11-01',async()=>[
  {fecha:'2026-10-30',compra:451,venta:456},
  {fecha:'2026-11-03',compra:499,venta:504}
 ]);
 assert.equal(res.statusCode,200);
 assert.equal(res.body.sourceDate,'2026-10-30');
});
test('identifica de manera transparente un espejo no oficial',async()=>{
 const res=await invoke('2026-11-04',async url=>{
  if(url.includes('hacienda.go.cr'))throw new Error('Hacienda temporalmente fuera de servicio');
  return {fecha:'04/11/2026',compra:447,venta:452};
 });
 assert.equal(res.statusCode,200);
 assert.equal(res.body.official,false);
 assert.match(res.body.source,/espejo independiente/);
});
test('no fabrica un tipo de cambio si no hay proveedores',async()=>{
 const res=await invoke('2026-11-04',async()=>{throw Error('Proveedor no disponible');});
 assert.equal(res.statusCode,503);
 assert.equal(res.body.sell,undefined);
});
test('rechaza fechas inválidas o futuras',async()=>{
 for(const date of ['2026-02-30','2099-01-01']){
  const res=await invoke(date,async()=>{throw Error('No debe consultar un proveedor');});
  assert.equal(res.statusCode,400);
 }
});
test('rechaza métodos distintos de GET',async()=>{
 const res=await invoke('2026-11-04',async()=>null,'POST');
 assert.equal(res.statusCode,405);
});
