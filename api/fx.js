'use strict';

// Vercel Node function. All rates are reference quotations (CRC per USD).
// Does not write to Supabase or persist any user financial data.
const HACIENDA='https://api.hacienda.go.cr/indicadores/tc/dolar';
const MIRROR='https://tipodecambio.paginasweb.cr/api';

function number(value) {
  if (value && typeof value==='object') value=value.valor??value.value??null;
  const n=Number(typeof value==='string'?value.replace(',','.'):value);
  return Number.isFinite(n)&&n>100&&n<1500?n:null;
}
function isoDate(value) {
  if(typeof value!=='string')return null;
  const raw=value.trim();
  let iso=raw.slice(0,10);
  if(/^\d{2}\/\d{2}\/\d{4}$/.test(raw)) {
    const [d,m,y]=raw.split('/');iso=`${y}-${m}-${d}`;
  }
  return /^\d{4}-\d{2}-\d{2}$/.test(iso)&&!Number.isNaN(Date.parse(iso+'T12:00:00Z'))?iso:null;
}
function isDate(value) {
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
  const dt=new Date(value+'T12:00:00Z');
  return !Number.isNaN(dt.getTime())&&dt.toISOString().slice(0,10)===value;
}
function asRow(obj) {
  if(!obj||typeof obj!=='object')return null;
  const buy=number(obj.compra??obj.buy),sell=number(obj.venta??obj.sell);
  const published=isoDate(obj.fecha??obj.date??obj.fechaPublicacion??obj.venta?.fecha??obj.compra?.fecha);
  return buy&&sell&&published?{date:published,buy,sell}:null;
}
function extractOfficialRows(data) {
  const rows=[];
  const visit=(value,depth=0)=>{
    if(depth>5||value==null)return;
    if(Array.isArray(value)){value.forEach(x=>visit(x,depth+1));return;}
    if(typeof value!=='object')return;
    const row=asRow(value);
    if(row)rows.push(row);
    // Hacienda's historic endpoint may return separate compra and venta arrays.
    if(Array.isArray(value.compra)&&Array.isArray(value.venta)){
      const buys=new Map(value.compra.map(x=>[isoDate(x.fecha??x.date),number(x)]).filter(x=>x[0]&&x[1]));
      for(const x of value.venta){
        const date=isoDate(x.fecha??x.date),sell=number(x),buy=buys.get(date);
        if(date&&sell&&buy)rows.push({date,buy,sell});
      }
    }
    for(const [k,nested] of Object.entries(value)){
      if(['compra','venta'].includes(k)&&Array.isArray(nested))continue;
      if(nested&&typeof nested==='object')visit(nested,depth+1);
    }
  };
  visit(data);
  return rows;
}
async function getJson(url){
  const response=await fetch(url,{headers:{accept:'application/json'},signal:AbortSignal.timeout(6500)});
  if(!response.ok)throw new Error('Proveedor HTTP '+response.status);
  return response.json();
}
function latestOnOrBefore(rows,date){
  return rows.filter(r=>r.date<=date&&r.buy&&r.sell).sort((a,b)=>b.date.localeCompare(a.date))[0]||null;
}
function minusDays(date,days){
  const dt=new Date(date+'T12:00:00Z');dt.setUTCDate(dt.getUTCDate()-days);
  return dt.toISOString().slice(0,10);
}
function todayInCostaRica(){
  const p=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Costa_Rica',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
  const fields=Object.fromEntries(p.filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));
  return fields.year+'-'+fields.month+'-'+fields.day;
}
module.exports=async function handler(req,res){
  res.setHeader('Content-Type','application/json; charset=utf-8');
  if(req.method!=='GET'){res.setHeader('Allow','GET');return res.status(405).json({error:'Solo GET'});}
  const today=todayInCostaRica();
  // Bulk historical rates: one upstream request serves many CRC transactions.
  // Only published dates on or before each requested date are eligible.
  if(req.query?.dates){
    const raw=String(req.query.dates);
    const dates=[...new Set(raw.split(',').map(x=>x.trim()))].sort();
    if(!dates.length||dates.length>100||dates.some(d=>!isDate(d)||d>today||d<'2013-01-01')){
      return res.status(400).json({error:'Indica entre 1 y 100 fechas válidas no futuras.'});
    }
    res.setHeader('Cache-Control','public, s-maxage=3600, stale-while-revalidate=86400');
    try{
      const start=minusDays(dates[0],10),end=dates[dates.length-1];
      const url=HACIENDA+'/historico?d='+start+'&h='+end;
      const rows=extractOfficialRows(await getJson(url));
      const rates={},missing=[];
      for(const date of dates){
        const row=latestOnOrBefore(rows,date);
        if(row)rates[date]={requestedDate:date,sourceDate:row.date,buy:row.buy,sell:row.sell,source:'Hacienda (referencia oficial)',official:true};
        else missing.push(date);
      }
      return res.status(200).json({rates,missing});
    }catch(error){
      return res.status(503).json({error:'No se pudo consultar el histórico por fechas.',detail:error.message});
    }
  }
  const date=req.query?.date;
  if(!isDate(date)||date>'9999-12-31'||date>today||date<'2013-01-01'){
    return res.status(400).json({error:'Fecha inválida, futura o anterior a 2013.'});
  }
  res.setHeader('Cache-Control',date===today?'public, s-maxage=300, stale-while-revalidate=600':'public, s-maxage=86400, stale-while-revalidate=604800');
  let lastError='No hay cotización disponible para esa fecha.';
  try {
    // A date-scoped range avoids using today's rate for historical operations.
    const url=HACIENDA+'/historico?d='+minusDays(date,10)+'&h='+date;
    const payload=await getJson(url);
    const row=latestOnOrBefore(extractOfficialRows(payload),date);
    if(row)return res.status(200).json({requestedDate:date,sourceDate:row.date,buy:row.buy,sell:row.sell,source:'Hacienda (referencia oficial)',sourceUrl:url,official:true});
    lastError='El histórico de Hacienda no devolvió una cotización interpretable.';
  }catch(error){lastError=error.message;}
  try {
    // Transparent, independent mirror of BCCR quotations, not an official endpoint.
    const [y,m,d]=date.split('-');
    const url=MIRROR+'/'+d+'/'+m+'/'+y;
    const row=asRow(await getJson(url));
    if(row&&row.date<=date)return res.status(200).json({requestedDate:date,sourceDate:row.date,buy:row.buy,sell:row.sell,source:'BCCR vía espejo independiente',sourceUrl:url,official:false});
    lastError='La fuente alternativa no devolvió una cotización válida.';
  }catch(error){lastError=error.message;}
  // Never substitute FX=520 or today's quote when a historical lookup fails.
  return res.status(503).json({error:'No fue posible consultar el tipo de cambio. Ingresalo manualmente antes de guardar.',detail:lastError});
};
