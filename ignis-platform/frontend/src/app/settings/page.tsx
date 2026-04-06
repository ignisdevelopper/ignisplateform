/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { motion, AnimatePresence } from 'framer-motion';

const API_BASE = process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, '') ?? 'http://localhost:8000/api/v1';
const MONO = "'IBM Plex Mono', 'JetBrains Mono', 'Fira Code', monospace";

type SetupStatus = 'VALID'|'PENDING'|'INVALID'|'WATCH'|'EXPIRED';
type ZoneType = 'DEMAND'|'SUPPLY'|'FLIPPY_D'|'FLIPPY_S'|'HIDDEN_D'|'HIDDEN_S';
type PAPattern = 'ACCU'|'THREE_DRIVES'|'FTL'|'PATTERN_69'|'HIDDEN_SDE'|'NONE';
type AssetClass = 'CRYPTO'|'STOCK'|'FOREX'|'COMMODITY'|'INDEX'|'ETF'|'OTHER';
type AlertChannel = 'WEBSOCKET'|'TELEGRAM';
type TabKey = 'assets'|'alertes'|'ai'|'telegram'|'systeme';

interface AssetResponse { symbol: string; asset_class: string; name: string; exchange: string; active: boolean; last_price?: number; last_analysis_at?: string; setup?: { status: SetupStatus; score: number; zone_type?: ZoneType; pa_pattern?: PAPattern; rr?: number }; created_at: string; updated_at: string; meta?: any }
interface AssetsListResponse { total: number; assets: AssetResponse[] }
interface AssetStatsResponse { total: number; active: number; by_class: Record<string,number>; with_analysis: number; valid_setups: number; pending_setups: number }
interface AlertStatsResponse { total: number; sent?: number; failed?: number; queued?: number }
interface AlertResponse { id: string; alert_type: string; priority: string; symbol: string; timeframe: string; title: string; message: string; emoji: string; payload: object; channels: string[]; status: string; created_at: string }
interface AIStatusResponse { ollama_online: boolean; model: string; host: string; version?: string }
interface AIModelsResponse { models: { name: string; size?: number; modified_at?: string }[] }

function fmt(n?: number|null, d=2) { if (n==null||Number.isNaN(n)) return '—'; return new Intl.NumberFormat('fr-FR',{maximumFractionDigits:d}).format(n); }
function fmtDate(iso?: string) { if (!iso) return '—'; const d=new Date(iso); return Number.isNaN(d.getTime())?iso:d.toLocaleString('fr-FR',{hour12:false}); }
function safeJson(s: string) { try { return {ok:true,value:s.trim()?JSON.parse(s):undefined}; } catch(e:any){return{ok:false,error:e?.message};} }

const STATUS_META: Record<string,{label:string;color:string;bg:string}> = {
  VALID:{label:'Valide',color:'#10b981',bg:'rgba(16,185,129,0.1)'},
  PENDING:{label:'En cours',color:'#38bdf8',bg:'rgba(56,189,248,0.1)'},
  WATCH:{label:'Surveiller',color:'#f59e0b',bg:'rgba(245,158,11,0.1)'},
  INVALID:{label:'Invalide',color:'#f43f5e',bg:'rgba(244,63,94,0.1)'},
  EXPIRED:{label:'Expiré',color:'#71717a',bg:'rgba(113,113,122,0.1)'},
};

const TABS: {key:TabKey;label:string;icon:string;desc:string}[] = [
  {key:'assets',   label:'Assets',     icon:'◈', desc:'Gérer ta watchlist'},
  {key:'alertes',  label:'Alertes',    icon:'⚡', desc:'Stats + test'},
  {key:'ai',       label:'Ollama / AI',icon:'◎', desc:'Modèles + test'},
  {key:'telegram', label:'Telegram',   icon:'◇', desc:'Config bot'},
  {key:'systeme',  label:'Système',    icon:'⚙', desc:'Diagnostic'},
];

export default function SettingsPage() {
  const [tab, setTab] = useState<TabKey>('assets');
  const [error, setError] = useState<string|null>(null);
  const [notice, setNotice] = useState<string|null>(null);

  // Assets
  const [assets, setAssets] = useState<AssetResponse[]>([]);
  const [assetsTotal, setAssetsTotal] = useState(0);
  const [assetsLoading, setAssetsLoading] = useState(false);
  const [assetStats, setAssetStats] = useState<AssetStatsResponse|null>(null);
  const [assetClass, setAssetClass] = useState<AssetClass|'ALL'>('CRYPTO');
  const [assetActive, setAssetActive] = useState<'ALL'|'true'|'false'>('true');
  const [assetQuery, setAssetQuery] = useState('');
  const [assetsLimit, setAssetsLimit] = useState(50);
  const [assetsOffset, setAssetsOffset] = useState(0);
  const [modalOpen, setModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState<'create'|'edit'>('create');
  const [assetForm, setAssetForm] = useState({symbol:'',asset_class:'CRYPTO' as AssetClass,name:'',exchange:'',active:true,metaJson:''});

  // Alerts
  const [alertStats, setAlertStats] = useState<AlertStatsResponse|null>(null);
  const [alertStatsLoading, setAlertStatsLoading] = useState(false);
  const [deadLetter, setDeadLetter] = useState<AlertResponse[]>([]);
  const [deadLoading, setDeadLoading] = useState(false);
  const [alertFilters, setAlertFilters] = useState<any>(null);
  const [emitOpen, setEmitOpen] = useState(false);
  const [emitForm, setEmitForm] = useState({mode:'emit' as 'emit'|'test',channel:'WEBSOCKET' as AlertChannel,alert_type:'SETUP',priority:'MEDIUM' as any,symbol:'BTCUSDT',timeframe:'H4',title:'Test alert',message:'Hello from Settings',payloadJson:'{"source":"settings"}',channels:['WEBSOCKET'] as AlertChannel[]});

  // AI
  const [aiStatus, setAiStatus] = useState<AIStatusResponse|null>(null);
  const [aiModels, setAiModels] = useState<AIModelsResponse|null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiModel, setAiModel] = useState('');
  const [aiPrompt, setAiPrompt] = useState('Donne un résumé du contexte S&D pour BTCUSDT H4.');
  const [aiOutput, setAiOutput] = useState('');
  const [aiChatLoading, setAiChatLoading] = useState(false);

  const filteredAssets = useMemo(() => {
    const q = assetQuery.trim().toUpperCase();
    if (!q) return assets;
    return assets.filter(a => `${a.symbol} ${a.name??''} ${a.exchange??''} ${a.asset_class??''}`.toUpperCase().includes(q));
  }, [assets, assetQuery]);
  const assetsPage = useMemo(() => Math.floor(assetsOffset/assetsLimit)+1, [assetsOffset,assetsLimit]);
  const assetsPages = useMemo(() => Math.max(1,Math.ceil(assetsTotal/assetsLimit)), [assetsTotal,assetsLimit]);

  const ok = (msg: string) => { setNotice(msg); setError(null); setTimeout(()=>setNotice(null),2500); };
  const err = (msg: string) => { setError(msg); setNotice(null); };

  // Fetchers
  const fetchAssets = useCallback(async () => {
    setAssetsLoading(true);
    try {
      const url = new URL(`${API_BASE}/assets`);
      if (assetClass!=='ALL') url.searchParams.set('asset_class',assetClass);
      if (assetActive!=='ALL') url.searchParams.set('active',assetActive);
      url.searchParams.set('limit',String(assetsLimit)); url.searchParams.set('offset',String(assetsOffset));
      const res = await fetch(url.toString());
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as AssetsListResponse;
      setAssets(data.assets??[]); setAssetsTotal(Number(data.total??data.assets?.length??0));
    } catch(e:any){err(e?.message);} finally{setAssetsLoading(false);}
  },[assetClass,assetActive,assetsLimit,assetsOffset]);

  const fetchAssetStats = useCallback(async () => {
    try { const res=await fetch(`${API_BASE}/assets/stats`); if(!res.ok) return; setAssetStats(await res.json()); } catch{}
  },[]);

  const fetchAlertStats = useCallback(async () => {
    setAlertStatsLoading(true);
    try { const res=await fetch(`${API_BASE}/alerts/stats`); if(!res.ok) throw new Error(`HTTP ${res.status}`); setAlertStats(await res.json()); } catch(e:any){err(e?.message);} finally{setAlertStatsLoading(false);}
  },[]);

  const fetchDeadLetter = useCallback(async () => {
    setDeadLoading(true);
    try { const res=await fetch(`${API_BASE}/alerts/dead-letter`); if(!res.ok) throw new Error(`HTTP ${res.status}`); const d=await res.json(); setDeadLetter(Array.isArray(d?.items??d?.alerts??d)?d?.items??d?.alerts??d:[]); } catch(e:any){err(e?.message);} finally{setDeadLoading(false);}
  },[]);

  const fetchAlertFilters = useCallback(async () => {
    try { const res=await fetch(`${API_BASE}/alerts/filters`); if(!res.ok) return; setAlertFilters(await res.json()); } catch{}
  },[]);

  const fetchAI = useCallback(async () => {
    setAiLoading(true);
    try {
      const [s,m] = await Promise.all([fetch(`${API_BASE}/ai/status`),fetch(`${API_BASE}/ai/models`)]);
      if (!s.ok||!m.ok) throw new Error('Erreur AI');
      const status=await s.json() as AIStatusResponse; const models=await m.json() as AIModelsResponse;
      setAiStatus(status); setAiModels(models);
      setAiModel(p=>p||status.model||models.models?.[0]?.name||'');
    } catch(e:any){err(e?.message);} finally{setAiLoading(false);}
  },[]);

  useEffect(()=>{fetchAssets();},[fetchAssets]);
  useEffect(()=>{fetchAssetStats();},[fetchAssetStats]);
  useEffect(()=>{
    if(tab==='alertes'){fetchAlertStats();fetchDeadLetter();fetchAlertFilters();}
    if(tab==='ai'){fetchAI();}
  },[tab]);

  // Asset CRUD
  const openCreate = () => { setAssetForm({symbol:'',asset_class:'CRYPTO',name:'',exchange:'',active:true,metaJson:''}); setModalMode('create'); setModalOpen(true); };
  const openEdit = (a: AssetResponse) => { setAssetForm({symbol:a.symbol,asset_class:a.asset_class as AssetClass,name:a.name??'',exchange:a.exchange??'',active:!!a.active,metaJson:a.meta?JSON.stringify(a.meta,null,2):''}); setModalMode('edit'); setModalOpen(true); };

  const submitAsset = async () => {
    const sym = assetForm.symbol.trim().toUpperCase();
    if (!sym) { err('Symbole requis.'); return; }
    const meta = safeJson(assetForm.metaJson);
    if (!meta.ok) { err(`Meta JSON invalide: ${meta.error}`); return; }
    try {
      if (modalMode==='create') {
        const res=await fetch(`${API_BASE}/assets`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({symbol:sym,asset_class:assetForm.asset_class,name:assetForm.name||undefined,exchange:assetForm.exchange||undefined,active:assetForm.active})});
        if (!res.ok) throw new Error(`HTTP ${res.status} — ${await res.text().catch(()=>'')}`);
        ok(`Asset créé : ${sym}`);
      } else {
        const res=await fetch(`${API_BASE}/assets/${encodeURIComponent(sym)}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:assetForm.name||undefined,exchange:assetForm.exchange||undefined,active:assetForm.active,meta:meta.value})});
        if (!res.ok) throw new Error(`HTTP ${res.status} — ${await res.text().catch(()=>'')}`);
        ok(`Asset mis à jour : ${sym}`);
      }
      setModalOpen(false); await Promise.all([fetchAssets(),fetchAssetStats()]);
    } catch(e:any){err(e?.message);}
  };

  const deleteAsset = async (sym: string) => {
    if (!confirm(`Supprimer ${sym} ?`)) return;
    try { const res=await fetch(`${API_BASE}/assets/${encodeURIComponent(sym)}`,{method:'DELETE'}); if(!res.ok) throw new Error(`HTTP ${res.status}`); ok(`Supprimé : ${sym}`); await Promise.all([fetchAssets(),fetchAssetStats()]); } catch(e:any){err(e?.message);}
  };

  const refreshAsset = async (sym: string) => {
    try { await fetch(`${API_BASE}/assets/${encodeURIComponent(sym)}/refresh`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({timeframe:'H4',force:false})}); ok(`Analyse lancée : ${sym}`); setTimeout(fetchAssets,1000); } catch(e:any){err(e?.message);}
  };

  // Alert actions
  const clearDeadLetter = async () => {
    if (!confirm('Vider la dead-letter ?')) return;
    try { await fetch(`${API_BASE}/alerts/dead-letter`,{method:'DELETE'}); ok('Dead-letter vidée.'); fetchDeadLetter(); } catch(e:any){err(e?.message);}
  };

  const submitEmit = async () => {
    const sym = emitForm.symbol.trim().toUpperCase();
    if (!sym) { err('Symbole requis.'); return; }
    try {
      if (emitForm.mode==='test') {
        const res=await fetch(`${API_BASE}/alerts/test`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({channel:emitForm.channel,symbol:sym,message:emitForm.message})});
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        ok(`Test envoyé via ${emitForm.channel}`); setEmitOpen(false);
      } else {
        const payload=safeJson(emitForm.payloadJson);
        if (!payload.ok){err(`Payload invalide: ${payload.error}`);return;}
        const res=await fetch(`${API_BASE}/alerts/emit`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({alert_type:emitForm.alert_type,priority:emitForm.priority,symbol:sym,timeframe:emitForm.timeframe,title:emitForm.title,message:emitForm.message,payload:payload.value??{},channels:emitForm.channels})});
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        ok('Alerte émise.'); setEmitOpen(false);
      }
      await Promise.all([fetchAlertStats(),fetchDeadLetter()]);
    } catch(e:any){err(e?.message);}
  };

  // AI chat
  const runAI = async () => {
    setAiChatLoading(true);
    try {
      const res=await fetch(`${API_BASE}/ai/chat`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({symbol:'SETTINGS',timeframe:'H4',model:aiModel||undefined,temperature:0.4,stream:false,messages:[{role:'system',content:'Tu es IGNIS AI. Réponds en français, concis et actionnable.'},{role:'user',content:aiPrompt}]})});
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data=await res.json(); setAiOutput(data?.response??'');
      ok(`Réponse reçue · modèle: ${data?.model??aiModel??'—'}`);
    } catch(e:any){err(e?.message);} finally{setAiChatLoading(false);}
  };

  return (
    <div className="relative min-h-screen p-5 md:p-6" style={{fontFamily:MONO}}>

      {/* Header */}
      <div className="mb-5 flex items-center justify-between gap-4 rounded-xl px-4 py-2.5"
        style={{background:'rgba(255,255,255,0.03)',border:'1px solid rgba(255,255,255,0.07)'}}>
        <div className="flex items-center gap-3">
          <Link href="/" className="text-xs px-3 py-1.5 rounded-lg transition-all"
            style={{background:'rgba(255,255,255,0.05)',border:'1px solid rgba(255,255,255,0.08)',color:'rgba(255,255,255,0.6)'}}>
            ← Dashboard
          </Link>
          <span className="text-xs font-bold" style={{color:'#f59e0b',letterSpacing:'0.15em'}}>PARAMÈTRES</span>
        </div>
        <a href={API_BASE.replace(/\/api\/v1$/,'')+'/docs'} target="_blank" rel="noreferrer"
          className="text-xs px-3 py-1.5 rounded-lg transition-all"
          style={{background:'rgba(255,255,255,0.05)',border:'1px solid rgba(255,255,255,0.08)',color:'rgba(255,255,255,0.5)'}}>
          Swagger →
        </a>
      </div>

      {/* Notices */}
      <AnimatePresence>
        {notice && <motion.div initial={{opacity:0,y:-8}} animate={{opacity:1,y:0}} exit={{opacity:0}} className="mb-4 rounded-xl px-4 py-3 text-sm" style={{background:'rgba(16,185,129,0.08)',border:'1px solid rgba(16,185,129,0.2)',color:'#10b981'}}>✓ {notice}</motion.div>}
        {error && <motion.div initial={{opacity:0,y:-8}} animate={{opacity:1,y:0}} exit={{opacity:0}} className="mb-4 rounded-xl px-4 py-3 text-sm" style={{background:'rgba(244,63,94,0.08)',border:'1px solid rgba(244,63,94,0.2)',color:'#f43f5e'}}>✕ {error}</motion.div>}
      </AnimatePresence>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-12">

        {/* Sidebar tabs */}
        <div className="xl:col-span-2">
          <div className="rounded-2xl p-2 space-y-1 sticky top-4" style={{background:'rgba(255,255,255,0.03)',border:'1px solid rgba(255,255,255,0.07)'}}>
            <div className="px-3 py-2 mb-2">
              <div className="text-[10px] font-semibold uppercase tracking-wider" style={{color:'rgba(255,255,255,0.3)',letterSpacing:'0.12em'}}>Navigation</div>
            </div>
            {TABS.map(t => (
              <button key={t.key} onClick={()=>setTab(t.key)} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-all"
                style={{background:tab===t.key?'rgba(245,158,11,0.12)':'transparent',border:`1px solid ${tab===t.key?'rgba(245,158,11,0.25)':'transparent'}`}}
                onMouseEnter={e=>{if(tab!==t.key)(e.currentTarget as HTMLElement).style.background='rgba(255,255,255,0.04)';}}
                onMouseLeave={e=>{if(tab!==t.key)(e.currentTarget as HTMLElement).style.background='transparent';}}>
                <span className="text-sm" style={{color:tab===t.key?'#f59e0b':'rgba(255,255,255,0.4)'}}>{t.icon}</span>
                <div className="min-w-0">
                  <div className="text-xs font-medium" style={{color:tab===t.key?'rgba(255,255,255,0.9)':'rgba(255,255,255,0.6)'}}>{t.label}</div>
                  <div className="text-[10px] truncate" style={{color:'rgba(255,255,255,0.3)'}}>{t.desc}</div>
                </div>
              </button>
            ))}
            <div className="px-3 pt-3 pb-1 mt-2" style={{borderTop:'1px solid rgba(255,255,255,0.07)'}}>
              <div className="text-[10px]" style={{color:'rgba(255,255,255,0.25)'}}>{API_BASE.replace(/https?:\/\//,'').slice(0,28)}…</div>
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="xl:col-span-10">
          <AnimatePresence mode="wait">

            {/* ══ ASSETS ══ */}
            {tab==='assets' && (
              <motion.div key="assets" initial={{opacity:0,y:8}} animate={{opacity:1,y:0}} exit={{opacity:0,y:-8}} className="space-y-4">

                {/* Stats */}
                <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
                  {[
                    {l:'Total',v:String(assetStats?.total??'—'),c:'#ffffff'},
                    {l:'Actifs',v:String(assetStats?.active??'—'),c:'#10b981'},
                    {l:'Analysés',v:String(assetStats?.with_analysis??'—'),c:'#378add'},
                    {l:'Setups valides',v:String((assetStats as any)?.valid_setups??'—'),c:'#10b981'},
                    {l:'En attente',v:String((assetStats as any)?.pending_setups??'—'),c:'#f59e0b'},
                  ].map((s,i)=>(
                    <motion.div key={s.l} initial={{opacity:0,y:12}} animate={{opacity:1,y:0}} transition={{delay:i*0.04}}
                      className="rounded-2xl p-3" style={{background:'rgba(255,255,255,0.03)',border:'1px solid rgba(255,255,255,0.07)'}}>
                      <div className="text-[11px] mb-1" style={{color:'rgba(255,255,255,0.4)'}}>{s.l}</div>
                      <div className="text-xl font-bold tabular-nums" style={{color:s.c,fontFamily:MONO}}>{s.v}</div>
                    </motion.div>
                  ))}
                </div>

                {/* Toolbar */}
                <div className="flex flex-wrap items-center gap-3">
                  <select value={assetClass} onChange={e=>{setAssetsOffset(0);setAssetClass(e.target.value as any)}}
                    className="text-xs rounded-xl px-3 py-2.5 outline-none"
                    style={{background:'rgba(0,0,0,0.4)',border:'1px solid rgba(255,255,255,0.1)',color:'rgba(255,255,255,0.7)'}}>
                    {['ALL','CRYPTO','STOCK','FOREX','INDEX','ETF','COMMODITY','OTHER'].map(c=><option key={c} value={c}>{c}</option>)}
                  </select>
                  <select value={assetActive} onChange={e=>{setAssetsOffset(0);setAssetActive(e.target.value as any)}}
                    className="text-xs rounded-xl px-3 py-2.5 outline-none"
                    style={{background:'rgba(0,0,0,0.4)',border:'1px solid rgba(255,255,255,0.1)',color:'rgba(255,255,255,0.7)'}}>
                    <option value="ALL">Tous</option><option value="true">Actifs</option><option value="false">Inactifs</option>
                  </select>
                  <div className="relative flex-1 min-w-[200px]">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs" style={{color:'rgba(255,255,255,0.3)'}}>⌕</span>
                    <input value={assetQuery} onChange={e=>setAssetQuery(e.target.value)} placeholder="Rechercher…"
                      className="w-full rounded-xl pl-9 pr-4 py-2.5 text-xs outline-none"
                      style={{background:'rgba(0,0,0,0.35)',border:'1px solid rgba(255,255,255,0.08)',color:'rgba(255,255,255,0.8)',fontFamily:MONO}} />
                  </div>
                  <div className="flex items-center gap-2 ml-auto">
                    <button onClick={()=>{fetchAssets();fetchAssetStats();}} className="text-xs px-3 py-2.5 rounded-xl transition-all"
                      style={{background:'rgba(255,255,255,0.05)',border:'1px solid rgba(255,255,255,0.08)',color:'rgba(255,255,255,0.6)'}}>
                      ↻ Actualiser
                    </button>
                    <button onClick={openCreate} className="text-xs px-4 py-2.5 rounded-xl font-semibold transition-all"
                      style={{background:'rgba(232,93,26,0.2)',border:'1px solid rgba(232,93,26,0.35)',color:'#e85d1a'}}>
                      + Nouvel asset
                    </button>
                  </div>
                </div>

                {/* Table */}
                <div className="rounded-2xl overflow-hidden" style={{border:'1px solid rgba(255,255,255,0.07)'}}>
                  <div className="flex items-center justify-between px-4 py-3" style={{background:'rgba(0,0,0,0.3)',borderBottom:'1px solid rgba(255,255,255,0.07)'}}>
                    <span className="text-xs font-semibold" style={{color:'rgba(255,255,255,0.6)'}}>Liste des assets</span>
                    <span className="text-xs" style={{color:'rgba(255,255,255,0.3)'}}>{filteredAssets.length} affichés · {assetsTotal} total · page {assetsPage}/{assetsPages}</span>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left">
                      <thead>
                        <tr style={{borderBottom:'1px solid rgba(255,255,255,0.06)'}}>
                          {['Symbole','Classe','Exchange','Statut','Prix','Dernière analyse','Setup','Actions'].map(h=>(
                            <th key={h} className="px-4 py-3 text-[11px] font-semibold uppercase tracking-wider" style={{color:'rgba(255,255,255,0.3)',letterSpacing:'0.08em'}}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {assetsLoading && <tr><td colSpan={8} className="px-4 py-8 text-center text-sm" style={{color:'rgba(255,255,255,0.4)'}}>Chargement…</td></tr>}
                        {!assetsLoading && filteredAssets.length===0 && (
                          <tr><td colSpan={8} className="px-4 py-10 text-center">
                            <div className="text-2xl mb-2" style={{color:'rgba(255,255,255,0.15)'}}>◈</div>
                            <div className="text-sm" style={{color:'rgba(255,255,255,0.4)'}}>Aucun asset trouvé</div>
                            <div className="text-xs mt-1" style={{color:'rgba(255,255,255,0.25)'}}>Clique "+ Nouvel asset" pour en ajouter un.</div>
                          </td></tr>
                        )}
                        {filteredAssets.map((a,i)=>{
                          const sm = a.setup?.status?STATUS_META[a.setup.status]:null;
                          return (
                            <tr key={a.symbol} style={{borderBottom:'1px solid rgba(255,255,255,0.04)',background:i%2===0?'transparent':'rgba(255,255,255,0.01)'}}
                              onMouseEnter={e=>{(e.currentTarget as HTMLElement).style.background='rgba(255,255,255,0.04)';}}
                              onMouseLeave={e=>{(e.currentTarget as HTMLElement).style.background=i%2===0?'transparent':'rgba(255,255,255,0.01)';}}>
                              <td className="px-4 py-3">
                                <div className="text-sm font-bold" style={{color:'rgba(255,255,255,0.9)',fontFamily:MONO}}>{a.symbol}</div>
                                <div className="text-[11px] truncate max-w-[160px]" style={{color:'rgba(255,255,255,0.35)'}}>{a.name||'—'}</div>
                              </td>
                              <td className="px-4 py-3"><span className="text-xs px-2 py-0.5 rounded" style={{background:'rgba(255,255,255,0.06)',color:'rgba(255,255,255,0.5)'}}>{a.asset_class}</span></td>
                              <td className="px-4 py-3 text-xs" style={{color:'rgba(255,255,255,0.5)'}}>{a.exchange||'—'}</td>
                              <td className="px-4 py-3">
                                <span className="text-[11px] px-2 py-0.5 rounded-lg font-medium"
                                  style={{background:a.active?'rgba(16,185,129,0.1)':'rgba(113,113,122,0.1)',color:a.active?'#10b981':'#71717a'}}>
                                  {a.active?'Actif':'Inactif'}
                                </span>
                              </td>
                              <td className="px-4 py-3 text-xs tabular-nums" style={{color:'rgba(255,255,255,0.7)',fontFamily:MONO}}>{fmt(a.last_price,4)}</td>
                              <td className="px-4 py-3 text-xs" style={{color:'rgba(255,255,255,0.4)'}}>{a.last_analysis_at?fmtDate(a.last_analysis_at):'Jamais'}</td>
                              <td className="px-4 py-3">
                                {a.setup && sm ? (
                                  <div className="flex flex-wrap gap-1">
                                    <span className="text-[11px] px-1.5 py-0.5 rounded" style={{background:sm.bg,color:sm.color}}>{sm.label}</span>
                                    <span className="text-[11px] px-1.5 py-0.5 rounded tabular-nums" style={{background:'rgba(255,255,255,0.05)',color:'rgba(255,255,255,0.5)'}}>{fmt(a.setup.score,0)}%</span>
                                  </div>
                                ):<span style={{color:'rgba(255,255,255,0.2)'}}>—</span>}
                              </td>
                              <td className="px-4 py-3">
                                <div className="flex items-center gap-1.5">
                                  <Link href={`/analysis/${encodeURIComponent(a.symbol)}`}
                                    className="text-[11px] px-2.5 py-1.5 rounded-lg transition-all"
                                    style={{background:'rgba(232,93,26,0.1)',border:'1px solid rgba(232,93,26,0.2)',color:'#e85d1a'}}>
                                    Ouvrir
                                  </Link>
                                  <button onClick={()=>refreshAsset(a.symbol)} className="text-[11px] px-2.5 py-1.5 rounded-lg transition-all"
                                    style={{background:'rgba(16,185,129,0.08)',border:'1px solid rgba(16,185,129,0.2)',color:'#10b981'}}>
                                    ↻
                                  </button>
                                  <button onClick={()=>openEdit(a)} className="text-[11px] px-2.5 py-1.5 rounded-lg transition-all"
                                    style={{background:'rgba(255,255,255,0.05)',border:'1px solid rgba(255,255,255,0.1)',color:'rgba(255,255,255,0.55)'}}>
                                    Éditer
                                  </button>
                                  <button onClick={()=>deleteAsset(a.symbol)} className="text-[11px] px-2.5 py-1.5 rounded-lg transition-all"
                                    style={{background:'rgba(244,63,94,0.08)',border:'1px solid rgba(244,63,94,0.2)',color:'#f43f5e'}}>
                                    ✕
                                  </button>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  {assetsTotal>assetsLimit && (
                    <div className="flex items-center justify-between px-4 py-3" style={{borderTop:'1px solid rgba(255,255,255,0.06)'}}>
                      <span className="text-xs" style={{color:'rgba(255,255,255,0.3)'}}>Page {assetsPage}/{assetsPages}</span>
                      <div className="flex gap-2">
                        <button onClick={()=>setAssetsOffset(p=>Math.max(0,p-assetsLimit))} disabled={assetsOffset===0}
                          className="text-xs px-3 py-1.5 rounded-lg disabled:opacity-30 transition-all"
                          style={{background:'rgba(255,255,255,0.05)',border:'1px solid rgba(255,255,255,0.08)',color:'rgba(255,255,255,0.6)'}}>
                          ← Précédent
                        </button>
                        <button onClick={()=>setAssetsOffset(p=>Math.min((assetsPages-1)*assetsLimit,p+assetsLimit))} disabled={assetsOffset+assetsLimit>=assetsTotal}
                          className="text-xs px-3 py-1.5 rounded-lg disabled:opacity-30 transition-all"
                          style={{background:'rgba(255,255,255,0.05)',border:'1px solid rgba(255,255,255,0.08)',color:'rgba(255,255,255,0.6)'}}>
                          Suivant →
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                {/* Modal create/edit asset */}
                <PModal open={modalOpen} title={modalMode==='create'?'Nouvel asset':'Modifier l\'asset'} onClose={()=>setModalOpen(false)}
                  onConfirm={submitAsset} confirmLabel={modalMode==='create'?'Créer':'Enregistrer'}>
                  <div className="grid grid-cols-2 gap-3">
                    <FInput label="Symbole *" value={assetForm.symbol} onChange={v=>setAssetForm(p=>({...p,symbol:v}))} placeholder="BTCUSDT" disabled={modalMode==='edit'} />
                    <div>
                      <div className="text-[11px] mb-1.5" style={{color:'rgba(255,255,255,0.4)'}}>Classe d'actif</div>
                      <select value={assetForm.asset_class} onChange={e=>setAssetForm(p=>({...p,asset_class:e.target.value as AssetClass}))} disabled={modalMode==='edit'}
                        className="w-full rounded-xl px-3 py-2.5 text-xs outline-none disabled:opacity-50"
                        style={{background:'rgba(0,0,0,0.4)',border:'1px solid rgba(255,255,255,0.1)',color:'rgba(255,255,255,0.8)'}}>
                        {['CRYPTO','STOCK','FOREX','INDEX','ETF','COMMODITY','OTHER'].map(c=><option key={c} value={c}>{c}</option>)}
                      </select>
                    </div>
                    <FInput label="Nom" value={assetForm.name} onChange={v=>setAssetForm(p=>({...p,name:v}))} placeholder="Bitcoin" />
                    <FInput label="Exchange" value={assetForm.exchange} onChange={v=>setAssetForm(p=>({...p,exchange:v}))} placeholder="Binance" />
                    <div className="col-span-2">
                      <button onClick={()=>setAssetForm(p=>({...p,active:!p.active}))} className="w-full py-2.5 rounded-xl text-xs font-medium transition-all"
                        style={{background:assetForm.active?'rgba(16,185,129,0.1)':'rgba(113,113,122,0.1)',border:`1px solid ${assetForm.active?'rgba(16,185,129,0.25)':'rgba(113,113,122,0.2)'}`,color:assetForm.active?'#10b981':'#71717a'}}>
                        {assetForm.active?'● Actif':'○ Inactif'} — cliquer pour basculer
                      </button>
                    </div>
                    <div className="col-span-2">
                      <div className="text-[11px] mb-1.5" style={{color:'rgba(255,255,255,0.4)'}}>Meta JSON (optionnel)</div>
                      <textarea value={assetForm.metaJson} onChange={e=>setAssetForm(p=>({...p,metaJson:e.target.value}))} rows={5}
                        placeholder={'{\n  "watch": true,\n  "notes": "mon biais"\n}'}
                        className="w-full rounded-xl px-3 py-2.5 text-xs outline-none resize-none"
                        style={{background:'rgba(0,0,0,0.4)',border:'1px solid rgba(255,255,255,0.08)',color:'rgba(255,255,255,0.75)',fontFamily:MONO}} />
                    </div>
                  </div>
                </PModal>
              </motion.div>
            )}

            {/* ══ ALERTES ══ */}
            {tab==='alertes' && (
              <motion.div key="alertes" initial={{opacity:0,y:8}} animate={{opacity:1,y:0}} exit={{opacity:0,y:-8}} className="space-y-4">
                <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
                  {[
                    {l:'Total',v:String(alertStats?.total??'—'),c:'#ffffff'},
                    {l:'Envoyées',v:String(alertStats?.sent??'—'),c:'#10b981'},
                    {l:'Échouées',v:String(alertStats?.failed??'—'),c:'#f43f5e'},
                    {l:'En file',v:String(alertStats?.queued??'—'),c:'#f59e0b'},
                    {l:'Dead-letter',v:alertStatsLoading?'…':String(deadLetter.length),c:'#f43f5e'},
                  ].map((s,i)=>(
                    <motion.div key={s.l} initial={{opacity:0,y:12}} animate={{opacity:1,y:0}} transition={{delay:i*0.04}}
                      className="rounded-2xl p-3" style={{background:'rgba(255,255,255,0.03)',border:'1px solid rgba(255,255,255,0.07)'}}>
                      <div className="text-[11px] mb-1" style={{color:'rgba(255,255,255,0.4)'}}>{s.l}</div>
                      <div className="text-xl font-bold tabular-nums" style={{color:s.c,fontFamily:MONO}}>{s.v}</div>
                    </motion.div>
                  ))}
                </div>

                <div className="flex gap-3">
                  <button onClick={()=>{fetchAlertStats();fetchDeadLetter();fetchAlertFilters();}} className="text-xs px-3 py-2.5 rounded-xl transition-all"
                    style={{background:'rgba(255,255,255,0.05)',border:'1px solid rgba(255,255,255,0.08)',color:'rgba(255,255,255,0.6)'}}>
                    ↻ Actualiser
                  </button>
                  <button onClick={()=>setEmitOpen(true)} className="text-xs px-4 py-2.5 rounded-xl font-semibold transition-all"
                    style={{background:'rgba(232,93,26,0.2)',border:'1px solid rgba(232,93,26,0.35)',color:'#e85d1a'}}>
                    ⚡ Envoyer une alerte test
                  </button>
                </div>

                <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                  {/* Dead-letter */}
                  <div className="rounded-2xl overflow-hidden" style={{border:'1px solid rgba(255,255,255,0.07)'}}>
                    <div className="flex items-center justify-between px-4 py-3" style={{background:'rgba(0,0,0,0.3)',borderBottom:'1px solid rgba(255,255,255,0.07)'}}>
                      <span className="text-xs font-semibold" style={{color:'rgba(255,255,255,0.6)'}}>Dead-letter queue</span>
                      <div className="flex gap-2">
                        <button onClick={fetchDeadLetter} className="text-[11px] px-2.5 py-1.5 rounded-lg" style={{background:'rgba(255,255,255,0.05)',color:'rgba(255,255,255,0.5)'}}>↻</button>
                        <button onClick={clearDeadLetter} className="text-[11px] px-2.5 py-1.5 rounded-lg" style={{background:'rgba(244,63,94,0.08)',color:'#f43f5e'}}>Vider</button>
                      </div>
                    </div>
                    <div className="p-4 space-y-2 max-h-96 overflow-auto">
                      {deadLoading && <div className="text-xs text-center py-4" style={{color:'rgba(255,255,255,0.4)'}}>Chargement…</div>}
                      {!deadLoading && deadLetter.length===0 && <div className="text-xs text-center py-6" style={{color:'rgba(255,255,255,0.3)'}}>Aucun message en attente ✓</div>}
                      {deadLetter.slice(0,20).map(a=>(
                        <div key={a.id} className="rounded-xl p-3" style={{background:'rgba(244,63,94,0.05)',border:'1px solid rgba(244,63,94,0.15)'}}>
                          <div className="flex items-start justify-between gap-2">
                            <div className="text-xs font-semibold" style={{color:'rgba(255,255,255,0.8)',fontFamily:MONO}}>{a.symbol} <span style={{color:'rgba(255,255,255,0.4)',fontWeight:400}}>· {a.alert_type}</span></div>
                            <span className="text-[10px] px-1.5 py-0.5 rounded" style={{background:'rgba(244,63,94,0.1)',color:'#f43f5e'}}>{a.priority}</span>
                          </div>
                          <div className="text-[11px] mt-1" style={{color:'rgba(255,255,255,0.5)'}}>{a.message}</div>
                          <div className="text-[10px] mt-1" style={{color:'rgba(255,255,255,0.25)'}}>{fmtDate(a.created_at)}</div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Filters */}
                  <div className="rounded-2xl overflow-hidden" style={{border:'1px solid rgba(255,255,255,0.07)'}}>
                    <div className="flex items-center justify-between px-4 py-3" style={{background:'rgba(0,0,0,0.3)',borderBottom:'1px solid rgba(255,255,255,0.07)'}}>
                      <span className="text-xs font-semibold" style={{color:'rgba(255,255,255,0.6)'}}>Filtres backend</span>
                      <span className="text-[11px]" style={{color:'rgba(255,255,255,0.3)'}}>/alerts/filters</span>
                    </div>
                    <pre className="p-4 text-[11px] overflow-auto max-h-96" style={{color:'rgba(255,255,255,0.5)',fontFamily:MONO}}>
                      {alertFilters?JSON.stringify(alertFilters,null,2):'Chargement…'}
                    </pre>
                  </div>
                </div>

                {/* Modal emit */}
                <PModal open={emitOpen} title="Envoyer une alerte" onClose={()=>setEmitOpen(false)} onConfirm={submitEmit} confirmLabel="Envoyer">
                  <div className="space-y-3">
                    <div className="flex gap-2">
                      {(['emit','test'] as const).map(m=>(
                        <button key={m} onClick={()=>setEmitForm(p=>({...p,mode:m}))} className="flex-1 py-2 rounded-xl text-xs font-medium transition-all"
                          style={{background:emitForm.mode===m?'rgba(232,93,26,0.15)':'rgba(255,255,255,0.04)',border:`1px solid ${emitForm.mode===m?'rgba(232,93,26,0.3)':'rgba(255,255,255,0.08)'}`,color:emitForm.mode===m?'#e85d1a':'rgba(255,255,255,0.5)'}}>
                          {m==='emit'?'Émettre (enregistrer + router)':'Test (ping simple)'}
                        </button>
                      ))}
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <FInput label="Symbole *" value={emitForm.symbol} onChange={v=>setEmitForm(p=>({...p,symbol:v}))} placeholder="BTCUSDT" />
                      {emitForm.mode==='test'?(
                        <div>
                          <div className="text-[11px] mb-1.5" style={{color:'rgba(255,255,255,0.4)'}}>Canal</div>
                          <select value={emitForm.channel} onChange={e=>setEmitForm(p=>({...p,channel:e.target.value as AlertChannel}))}
                            className="w-full rounded-xl px-3 py-2.5 text-xs outline-none"
                            style={{background:'rgba(0,0,0,0.4)',border:'1px solid rgba(255,255,255,0.1)',color:'rgba(255,255,255,0.8)'}}>
                            <option value="WEBSOCKET">WEBSOCKET</option><option value="TELEGRAM">TELEGRAM</option>
                          </select>
                        </div>
                      ):(
                        <div>
                          <div className="text-[11px] mb-1.5" style={{color:'rgba(255,255,255,0.4)'}}>Priorité</div>
                          <select value={emitForm.priority} onChange={e=>setEmitForm(p=>({...p,priority:e.target.value as any}))}
                            className="w-full rounded-xl px-3 py-2.5 text-xs outline-none"
                            style={{background:'rgba(0,0,0,0.4)',border:'1px solid rgba(255,255,255,0.1)',color:'rgba(255,255,255,0.8)'}}>
                            {['LOW','MEDIUM','HIGH','CRITICAL'].map(p=><option key={p} value={p}>{p}</option>)}
                          </select>
                        </div>
                      )}
                    </div>
                    {emitForm.mode==='emit' && (
                      <>
                        <div className="grid grid-cols-2 gap-3">
                          <FInput label="Type d'alerte" value={emitForm.alert_type} onChange={v=>setEmitForm(p=>({...p,alert_type:v}))} placeholder="SETUP" />
                          <FInput label="Timeframe" value={emitForm.timeframe} onChange={v=>setEmitForm(p=>({...p,timeframe:v}))} placeholder="H4" />
                        </div>
                        <FInput label="Titre" value={emitForm.title} onChange={v=>setEmitForm(p=>({...p,title:v}))} placeholder="Test alert" />
                        <div className="flex gap-2">
                          {(['WEBSOCKET','TELEGRAM'] as AlertChannel[]).map(ch=>(
                            <button key={ch} onClick={()=>setEmitForm(p=>({...p,channels:p.channels.includes(ch)?p.channels.filter(x=>x!==ch):[...p.channels,ch]}))}
                              className="text-xs px-3 py-2 rounded-xl transition-all"
                              style={{background:emitForm.channels.includes(ch)?'rgba(56,122,221,0.15)':'rgba(255,255,255,0.04)',border:`1px solid ${emitForm.channels.includes(ch)?'rgba(56,122,221,0.3)':'rgba(255,255,255,0.08)'}`,color:emitForm.channels.includes(ch)?'#378add':'rgba(255,255,255,0.4)'}}>
                              {ch}
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                    <div>
                      <div className="text-[11px] mb-1.5" style={{color:'rgba(255,255,255,0.4)'}}>Message</div>
                      <textarea value={emitForm.message} onChange={e=>setEmitForm(p=>({...p,message:e.target.value}))} rows={3}
                        className="w-full rounded-xl px-3 py-2.5 text-xs outline-none resize-none"
                        style={{background:'rgba(0,0,0,0.4)',border:'1px solid rgba(255,255,255,0.08)',color:'rgba(255,255,255,0.75)',fontFamily:MONO}} />
                    </div>
                  </div>
                </PModal>
              </motion.div>
            )}

            {/* ══ AI ══ */}
            {tab==='ai' && (
              <motion.div key="ai" initial={{opacity:0,y:8}} animate={{opacity:1,y:0}} exit={{opacity:0,y:-8}} className="space-y-4">
                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  {[
                    {l:'Ollama',v:aiStatus?String(aiStatus.ollama_online):'—',c:aiStatus?.ollama_online?'#10b981':'#f43f5e'},
                    {l:'Hôte',v:aiStatus?.host??'—',c:'#378add'},
                    {l:'Modèle défaut',v:aiStatus?.model??'—',c:'#8b5cf6'},
                    {l:'Modèles dispo',v:aiModels?String(aiModels.models?.length??0):'—',c:'#f59e0b'},
                  ].map((s,i)=>(
                    <motion.div key={s.l} initial={{opacity:0,y:12}} animate={{opacity:1,y:0}} transition={{delay:i*0.04}}
                      className="rounded-2xl p-3" style={{background:'rgba(255,255,255,0.03)',border:'1px solid rgba(255,255,255,0.07)'}}>
                      <div className="text-[11px] mb-1" style={{color:'rgba(255,255,255,0.4)'}}>{s.l}</div>
                      <div className="text-sm font-bold truncate" style={{color:s.c,fontFamily:MONO}}>{s.v}</div>
                    </motion.div>
                  ))}
                </div>

                <button onClick={fetchAI} disabled={aiLoading} className="text-xs px-3 py-2.5 rounded-xl transition-all disabled:opacity-50"
                  style={{background:'rgba(255,255,255,0.05)',border:'1px solid rgba(255,255,255,0.08)',color:'rgba(255,255,255,0.6)'}}>
                  {aiLoading?'Chargement…':'↻ Actualiser le statut'}
                </button>

                <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                  {/* Models list */}
                  <div className="rounded-2xl overflow-hidden" style={{border:'1px solid rgba(255,255,255,0.07)'}}>
                    <div className="px-4 py-3" style={{background:'rgba(0,0,0,0.3)',borderBottom:'1px solid rgba(255,255,255,0.07)'}}>
                      <span className="text-xs font-semibold" style={{color:'rgba(255,255,255,0.6)'}}>Modèles disponibles</span>
                    </div>
                    <div className="p-3 space-y-2 max-h-80 overflow-auto">
                      {(aiModels?.models??[]).length===0 && <div className="text-xs text-center py-6" style={{color:'rgba(255,255,255,0.3)'}}>Aucun modèle — vérifie que Ollama tourne</div>}
                      {(aiModels?.models??[]).map(m=>(
                        <button key={m.name} onClick={()=>setAiModel(m.name)} className="w-full flex items-center justify-between rounded-xl px-3 py-2.5 transition-all text-left"
                          style={{background:aiModel===m.name?'rgba(139,92,246,0.12)':'rgba(255,255,255,0.03)',border:`1px solid ${aiModel===m.name?'rgba(139,92,246,0.3)':'rgba(255,255,255,0.07)'}`}}>
                          <div>
                            <div className="text-xs font-semibold" style={{color:aiModel===m.name?'#8b5cf6':'rgba(255,255,255,0.8)',fontFamily:MONO}}>{m.name}</div>
                            <div className="text-[10px]" style={{color:'rgba(255,255,255,0.3)'}}>{m.size?`${fmt(m.size/1e9,2)} GB`:'—'}</div>
                          </div>
                          {aiModel===m.name && <span className="text-xs" style={{color:'#8b5cf6'}}>✓ Sélectionné</span>}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Quick test */}
                  <div className="rounded-2xl overflow-hidden" style={{border:'1px solid rgba(255,255,255,0.07)'}}>
                    <div className="flex items-center justify-between px-4 py-3" style={{background:'rgba(0,0,0,0.3)',borderBottom:'1px solid rgba(255,255,255,0.07)'}}>
                      <span className="text-xs font-semibold" style={{color:'rgba(255,255,255,0.6)'}}>Test rapide AI</span>
                      <button onClick={runAI} disabled={aiChatLoading} className="text-xs px-3 py-1.5 rounded-lg font-semibold disabled:opacity-50 transition-all"
                        style={{background:'rgba(139,92,246,0.2)',border:'1px solid rgba(139,92,246,0.35)',color:'#8b5cf6'}}>
                        {aiChatLoading?'…':'▶ Envoyer'}
                      </button>
                    </div>
                    <div className="p-4 space-y-3">
                      <FInput label="Modèle (laisser vide = défaut)" value={aiModel} onChange={setAiModel} placeholder="llama3.1" />
                      <div>
                        <div className="text-[11px] mb-1.5" style={{color:'rgba(255,255,255,0.4)'}}>Prompt</div>
                        <textarea value={aiPrompt} onChange={e=>setAiPrompt(e.target.value)} rows={4}
                          className="w-full rounded-xl px-3 py-2.5 text-xs outline-none resize-none"
                          style={{background:'rgba(0,0,0,0.4)',border:'1px solid rgba(255,255,255,0.08)',color:'rgba(255,255,255,0.75)',fontFamily:MONO}} />
                      </div>
                      {aiOutput && (
                        <div>
                          <div className="text-[11px] mb-1.5" style={{color:'rgba(255,255,255,0.4)'}}>Réponse</div>
                          <div className="rounded-xl px-3 py-3 text-xs whitespace-pre-wrap max-h-48 overflow-auto"
                            style={{background:'rgba(139,92,246,0.05)',border:'1px solid rgba(139,92,246,0.15)',color:'rgba(255,255,255,0.75)',fontFamily:MONO}}>
                            {aiOutput}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </motion.div>
            )}

            {/* ══ TELEGRAM ══ */}
            {tab==='telegram' && (
              <motion.div key="telegram" initial={{opacity:0,y:8}} animate={{opacity:1,y:0}} exit={{opacity:0,y:-8}} className="space-y-4">
                <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                  <div className="rounded-2xl p-5" style={{background:'rgba(255,255,255,0.03)',border:'1px solid rgba(255,255,255,0.07)'}}>
                    <div className="text-xs font-semibold uppercase tracking-wider mb-4" style={{color:'rgba(255,255,255,0.5)',letterSpacing:'0.1em'}}>◇ Configuration requise</div>
                    <div className="space-y-2">
                      {[
                        {label:'TELEGRAM_BOT_TOKEN',desc:'Token du bot obtenu via @BotFather'},
                        {label:'TELEGRAM_CHAT_IDS',desc:'IDs des chats (séparés par virgule)'},
                        {label:'Bot démarré',desc:'Envoyer /start dans les chats ciblés'},
                        {label:'Backend accessible',desc:'Le serveur peut joindre api.telegram.org'},
                      ].map(item=>(
                        <div key={item.label} className="flex items-start gap-3 rounded-xl px-3 py-2.5"
                          style={{background:'rgba(255,255,255,0.03)',border:'1px solid rgba(255,255,255,0.06)'}}>
                          <span className="text-xs mt-0.5" style={{color:'rgba(255,255,255,0.2)'}}>○</span>
                          <div>
                            <div className="text-xs font-semibold" style={{color:'rgba(255,255,255,0.7)',fontFamily:MONO}}>{item.label}</div>
                            <div className="text-[11px]" style={{color:'rgba(255,255,255,0.35)'}}>{item.desc}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="rounded-2xl p-5" style={{background:'rgba(255,255,255,0.03)',border:'1px solid rgba(255,255,255,0.07)'}}>
                    <div className="text-xs font-semibold uppercase tracking-wider mb-4" style={{color:'rgba(255,255,255,0.5)',letterSpacing:'0.1em'}}>◇ Envoyer un test Telegram</div>
                    <div className="space-y-3">
                      <FInput label="Symbole" value={emitForm.symbol} onChange={v=>setEmitForm(p=>({...p,symbol:v}))} placeholder="BTCUSDT" />
                      <div>
                        <div className="text-[11px] mb-1.5" style={{color:'rgba(255,255,255,0.4)'}}>Message</div>
                        <textarea value={emitForm.message} onChange={e=>setEmitForm(p=>({...p,message:e.target.value}))} rows={3}
                          className="w-full rounded-xl px-3 py-2.5 text-xs outline-none resize-none"
                          style={{background:'rgba(0,0,0,0.4)',border:'1px solid rgba(255,255,255,0.08)',color:'rgba(255,255,255,0.75)',fontFamily:MONO}} />
                      </div>
                      <button onClick={async()=>{setEmitForm(p=>({...p,mode:'test',channel:'TELEGRAM'}));await submitEmit();}}
                        className="w-full py-2.5 rounded-xl text-xs font-semibold transition-all"
                        style={{background:'rgba(232,93,26,0.2)',border:'1px solid rgba(232,93,26,0.35)',color:'#e85d1a'}}>
                        Envoyer test Telegram →
                      </button>
                      <button onClick={()=>setEmitOpen(true)} className="w-full py-2.5 rounded-xl text-xs transition-all"
                        style={{background:'rgba(255,255,255,0.04)',border:'1px solid rgba(255,255,255,0.08)',color:'rgba(255,255,255,0.5)'}}>
                        Modal avancé (emit complet)
                      </button>
                    </div>
                  </div>
                </div>
              </motion.div>
            )}

            {/* ══ SYSTÈME ══ */}
            {tab==='systeme' && (
              <motion.div key="systeme" initial={{opacity:0,y:8}} animate={{opacity:1,y:0}} exit={{opacity:0,y:-8}} className="space-y-4">
                <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                  <div className="rounded-2xl p-5" style={{background:'rgba(255,255,255,0.03)',border:'1px solid rgba(255,255,255,0.07)'}}>
                    <div className="text-xs font-semibold uppercase tracking-wider mb-4" style={{color:'rgba(255,255,255,0.5)',letterSpacing:'0.1em'}}>⚙ Endpoints API</div>
                    <div className="space-y-1 text-xs" style={{color:'rgba(255,255,255,0.5)',fontFamily:MONO}}>
                      {[['Assets','/assets, /assets/stats'],['Analyse','/analysis/scan, /assets/{sym}/refresh'],['Alertes','/alerts/stats, /alerts/emit, /alerts/test, /alerts/dead-letter'],['AI','/ai/status, /ai/models, /ai/chat'],['WebSocket','/ws']].map(([cat,ep])=>(
                        <div key={cat} className="flex gap-3 py-1.5" style={{borderBottom:'1px solid rgba(255,255,255,0.05)'}}>
                          <span className="min-w-[80px]" style={{color:'rgba(255,255,255,0.35)'}}>{cat}</span>
                          <span style={{color:'rgba(255,255,255,0.6)'}}>{ep}</span>
                        </div>
                      ))}
                    </div>
                    <div className="flex gap-2 mt-4">
                      <a href={API_BASE.replace(/\/api\/v1$/,'')+'/docs'} target="_blank" rel="noreferrer"
                        className="flex-1 text-center text-xs py-2.5 rounded-xl transition-all"
                        style={{background:'rgba(255,255,255,0.06)',border:'1px solid rgba(255,255,255,0.1)',color:'rgba(255,255,255,0.7)'}}>
                        Swagger →
                      </a>
                      <a href={API_BASE.replace(/\/api\/v1$/,'')} target="_blank" rel="noreferrer"
                        className="flex-1 text-center text-xs py-2.5 rounded-xl transition-all"
                        style={{background:'rgba(255,255,255,0.06)',border:'1px solid rgba(255,255,255,0.1)',color:'rgba(255,255,255,0.7)'}}>
                        Backend root →
                      </a>
                    </div>
                  </div>

                  <div className="rounded-2xl p-5" style={{background:'rgba(255,255,255,0.03)',border:'1px solid rgba(255,255,255,0.07)'}}>
                    <div className="text-xs font-semibold uppercase tracking-wider mb-4" style={{color:'rgba(255,255,255,0.5)',letterSpacing:'0.1em'}}>⚙ Diagnostic rapide</div>
                    <div className="space-y-2 text-xs">
                      {[
                        {label:'API_BASE',value:API_BASE},
                        {label:'Assets chargés',value:String(assets.length)},
                        {label:'Dead-letter',value:String(deadLetter.length)},
                        {label:'Tab actif',value:tab},
                      ].map(row=>(
                        <div key={row.label} className="flex items-center justify-between py-1.5" style={{borderBottom:'1px solid rgba(255,255,255,0.05)'}}>
                          <span style={{color:'rgba(255,255,255,0.4)'}}>{row.label}</span>
                          <span className="truncate max-w-[200px]" style={{color:'rgba(255,255,255,0.7)',fontFamily:MONO}}>{row.value}</span>
                        </div>
                      ))}
                    </div>
                    <div className="mt-4 rounded-xl px-3 py-3 text-xs leading-relaxed" style={{background:'rgba(255,255,255,0.03)',border:'1px solid rgba(255,255,255,0.06)',color:'rgba(255,255,255,0.4)'}}>
                      <strong style={{color:'rgba(255,255,255,0.6)'}}>Problèmes courants :</strong><br/>
                      · Backend injoignable → vérifie <code style={{fontFamily:MONO,color:'rgba(255,255,255,0.6)'}}>NEXT_PUBLIC_API_URL</code><br/>
                      · Ollama offline → lance <code style={{fontFamily:MONO,color:'rgba(255,255,255,0.6)'}}>ollama serve</code><br/>
                      · Telegram KO → vérifie <code style={{fontFamily:MONO,color:'rgba(255,255,255,0.6)'}}>TELEGRAM_BOT_TOKEN</code>
                    </div>
                  </div>
                </div>
              </motion.div>
            )}

          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

/* ── Micro-composants ── */
function FInput({label,value,onChange,placeholder,disabled}:{label:string;value:string;onChange:(v:string)=>void;placeholder?:string;disabled?:boolean}) {
  const MONO = "'IBM Plex Mono', monospace";
  return (
    <div>
      <div className="text-[11px] mb-1.5" style={{color:'rgba(255,255,255,0.4)'}}>{label}</div>
      <input value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder} disabled={disabled}
        className="w-full rounded-xl px-3 py-2.5 text-xs outline-none disabled:opacity-50"
        style={{background:'rgba(0,0,0,0.4)',border:'1px solid rgba(255,255,255,0.1)',color:'rgba(255,255,255,0.8)',fontFamily:MONO}}
        onFocus={e=>{(e.target as HTMLElement).style.borderColor='rgba(245,158,11,0.4)';}}
        onBlur={e=>{(e.target as HTMLElement).style.borderColor='rgba(255,255,255,0.1)';}} />
    </div>
  );
}

function PModal({open,title,onClose,onConfirm,confirmLabel,children}:{open:boolean;title:string;onClose:()=>void;onConfirm:()=>void;confirmLabel:string;children:React.ReactNode}) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}}
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{background:'rgba(0,0,0,0.75)',backdropFilter:'blur(8px)'}}
          onClick={onClose}>
          <motion.div initial={{scale:0.96,opacity:0}} animate={{scale:1,opacity:1}} exit={{scale:0.96,opacity:0}}
            className="w-full max-w-lg rounded-3xl overflow-hidden"
            style={{background:'#0d0d14',border:'1px solid rgba(255,255,255,0.12)'}}
            onClick={e=>e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4" style={{borderBottom:'1px solid rgba(255,255,255,0.08)'}}>
              <span className="text-sm font-semibold" style={{color:'rgba(255,255,255,0.9)'}}>{title}</span>
              <button onClick={onClose} className="text-xs px-2.5 py-1.5 rounded-lg" style={{background:'rgba(255,255,255,0.06)',color:'rgba(255,255,255,0.4)'}}>✕ Fermer</button>
            </div>
            <div className="px-5 py-4 max-h-[70vh] overflow-auto">{children}</div>
            <div className="flex items-center justify-end gap-3 px-5 py-4" style={{borderTop:'1px solid rgba(255,255,255,0.08)'}}>
              <button onClick={onClose} className="text-xs px-4 py-2.5 rounded-xl transition-all"
                style={{background:'rgba(255,255,255,0.06)',border:'1px solid rgba(255,255,255,0.1)',color:'rgba(255,255,255,0.6)'}}>
                Annuler
              </button>
              <button onClick={onConfirm} className="text-xs px-5 py-2.5 rounded-xl font-semibold transition-all"
                style={{background:'rgba(245,158,11,0.2)',border:'1px solid rgba(245,158,11,0.35)',color:'#f59e0b'}}>
                {confirmLabel}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}