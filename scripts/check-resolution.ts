/** Offline behavior checks. Real matching/processor/cache/worker; external IO mocked. */
import assert from 'node:assert/strict';
import { choosePlace, placeNameQueries, type SearchPlace } from '../lib/google/places';
import { cityClue } from '../lib/pipeline/nameCandidates';
import { loadSource, processorFixture } from './check-transcript';
let passed = 0;
async function check(label: string, body: () => unknown) { await body(); passed++; console.log('PASS', label); }
const caption = 'Trying the best shawarma in Mississauga? Yaseen shawarma Getting the shawarma plate. #torontoeats #torontofood #shawarma #mississauga #toronto';
const place = (placeId='branch-1', city='Mississauga', name='Yaseen Shawarma', types=['restaurant']): SearchPlace => ({placeId,city,name,types,address:`1 Main Street, ${city}, ON, Canada`,businessStatus:'OPERATIONAL'});

function captionFixture(enabled: boolean | null=true, response: any={platform:'tiktok',id:'123',description:caption}, initial: any={}, vercelEnv?:string) {
  const row: any={...initial};let requests=0;
  const database={from(){let fields='';const query: any={select(s: string){fields=s;return query;},eq(){return query;},not(){return query;},neq(){return query;},order(){return query;},limit(){return query;},
    maybeSingle:async()=>({data:fields.includes('caption_source')?(row.caption?{...row}:null):(row.caption_fetch_status?{...row}:null)}),
    update(patch: any){Object.assign(row,patch);return query;},then(resolve: any,reject: any){return Promise.resolve({error:null}).then(resolve,reject);}};return query;}};
  const dependencies={'@/lib/supabase/client':{supabase:database}};
  const globals={process:{env:{...(enabled===null?{}:{CAPTION_METADATA_ENABLED:enabled?'true':'false'}),VERCEL_ENV:vercelEnv,SUPADATA_API_KEY:'offline-fixture'}},fetch:async()=>{requests++;return{ok:true,status:200,json:async()=>response};}};
  return {row,get requests(){return requests;},fresh:()=>loadSource('lib/pipeline/caption.ts',dependencies,globals)};
}

async function run() {
  await check('matching requires actual food types and business-name evidence',()=>{
    assert.equal(choosePlace('Yaseen Shawarma','Mississauga',[place('store','Mississauga','Yaseen Electronics',['electronics_store','food'])]),null);
    assert.equal(choosePlace('Yaseen Shawarma','Mississauga',[place('wrong','Mississauga','Other Shawarma')]),null);
    assert.equal(choosePlace('Yaseen Shawarma','Mississauga',[place()])?.locationVerified,true);
  });
  await check('a unique result with no city still needs location confirmation',()=>assert.equal(choosePlace('Yaseen Shawarma','',[place()])?.locationVerified,false));
  await check('a city conflict cannot become a saved address',()=>assert.equal(choosePlace('Yaseen Shawarma','Brampton',[place()])?.locationVerified,false));
  await check('a Toronto street name does not turn Brampton into Toronto',()=>assert.equal(choosePlace('Yaseen Shawarma','Toronto',[{...place('one','Brampton'),address:'1 Toronto Street, Brampton, ON, Canada'}])?.locationVerified,false));
  await check('two branches in the same city ask instead of choosing first',()=>{
    const result=choosePlace('Yaseen Shawarma','Mississauga',[place(),place('branch-2')]);assert.equal(result?.ambiguous,true);assert.equal(result?.locationVerified,false);assert.equal(result?.candidates.length,2);
  });
  await check('an explicit branch choice must be in the verified search results',()=>{
    assert.equal(choosePlace('Yaseen Shawarma','Mississauga',[place(),place('branch-2')],'branch-2')?.locationVerified,true);
    assert.equal(choosePlace('Yaseen Shawarma','Mississauga',[place()],'unknown-branch'),null);
  });
  await check('spelling and spacing search variants are bounded and contain no city',()=>{
    assert.equal(placeNameQueries('YaseenShawarma')[1],'Yaseen Shawarma');assert.equal(placeNameQueries('Yaseen shawerma')[1],'Yaseen shawarma');assert.ok(placeNameQueries('Yaseen-Shawarma').length<=2);
  });
  await check('prose Mississauga is not replaced by a general Toronto hashtag',()=>assert.equal(cityClue(caption,'','Toronto').city,'Mississauga'));
  await check('conflicting prose cities require a choice',()=>assert.equal(cityClue('Yasmine Shawarma in Toronto','We went there in Mississauga','Toronto').conflict,true));
  await check('an inferred Toronto default without source evidence is discarded',()=>assert.equal(cityClue('Yasmine shawarma plate','', 'Toronto').city,''));
  await check('metadata fallback passes the actual caption to the real processor',async()=>{
    const f=processorFixture('','ok','This is better than Messi Shawarma.',null,{caption,extraction:{restaurantName:'Messi Shawarma',city:'Toronto',isSponsored:false},place:{placeId:'verified',name:'Yaseen Shawarma',city:'Mississauga',locationVerified:true}});
    const result=await f.run();assert.equal(result.success,true);assert.equal(f.calls.find(c=>c.name==='extract')?.args[0],caption);assert.equal(f.calls.find(c=>c.name==='places')?.args[0],'Yaseen Shawarma');assert.equal(f.calls.find(c=>c.name==='places')?.args[1],'Mississauga');
  });
  await check('comparison names alone produce a name question without Places or writes',async()=>{
    const f=processorFixture('','ok','This is better than Messi shawarma.',null,{extraction:{restaurantName:null,city:null,isSponsored:false}});const result=await f.run();assert.equal(result.needsName,true);assert.ok(!f.calls.some(c=>['places','createRestaurant','createReview'].includes(c.name)));
  });
  await check('ambiguous branches return options and never write a review',async()=>{
    const f=processorFixture(caption,'unavailable',null,null,{place:{...place(),locationVerified:false,ambiguous:true,candidates:[place(),place('branch-2')]}});const result=await f.run();assert.equal(result.needsLocation,true);assert.ok(!f.calls.some(c=>c.name==='createReview'));assert.equal(f.calls.find(c=>c.name==='status')?.args[2].resolution.candidates.length,2);
  });
  await check('caption text survives an unavailable transcript',async()=>{
    const f=processorFixture('Yasmine shawarma in Toronto','unavailable',null,null,{extraction:{restaurantName:null,city:null,isSponsored:false},place:{...place('one','Toronto','Yasmine Shawarma'),locationVerified:true}});assert.equal((await f.run()).success,true);assert.equal(f.calls.find(c=>c.name==='places')?.args[0],'Yasmine Shawarma');
  });
  await check('disabled metadata feature spends no credit',async()=>{
    const f=captionFixture(false);assert.equal((await f.fresh().fetchCaption('job','123','https://www.tiktok.com/@test/video/123')).status,'not_attempted');assert.equal(f.requests,0);
  });
  await check('approved default is Production only and explicit false disables billing',async()=>{
    for(const [environment,flag,expected] of [['production',null,1],['preview',null,0],[undefined,null,0],['production',false,0]] as const){
      const f=captionFixture(flag,undefined,{},environment);await f.fresh().fetchCaption('job','123','https://www.tiktok.com/@test/video/123');assert.equal(f.requests,expected);
    }
  });
  await check('successful metadata is reused after the worker process restarts',async()=>{
    const f=captionFixture();await f.fresh().fetchCaption('job','123','https://www.tiktok.com/@test/video/123');assert.equal(f.row.caption,caption);assert.equal((await f.fresh().fetchCaption('job','123','https://www.tiktok.com/@test/video/123')).text,caption);assert.equal(f.requests,1);
  });
  await check('a recorded in-progress request is not billed again after interruption',async()=>{
    const f=captionFixture(true,{}, {caption_fetch_status:'pending'});assert.equal((await f.fresh().fetchCaption('job','123','https://www.tiktok.com/@test/video/123')).status,'pending');assert.equal(f.requests,0);
  });
  await check('missing description never fabricates a caption from a title',async()=>{
    const f=captionFixture(true,{platform:'tiktok',id:'123',title:'A generated title',description:null});const r=await f.fresh().fetchCaption('job','123','https://www.tiktok.com/@test/video/123');assert.equal(r.text,null);assert.equal(r.status,'unavailable');
  });
  await check('metadata for a different video is rejected without storing its text',async()=>{
    const f=captionFixture(true,{platform:'tiktok',id:'other',description:'wrong-video-caption'});assert.equal((await f.fresh().fetchCaption('job','123','https://www.tiktok.com/@test/video/123')).status,'failed');assert.equal(f.row.caption,undefined);
  });
  await check('worker loads the correction from the persisted record after a restart',async()=>{
    const hint={restaurantName:'Yaseen Shawarma',city:'Mississauga',placeId:'branch-2'};let received:any;
    const worker=loadSource('lib/pipeline/worker.ts',{'@/lib/supabase/queries':{getSubmissionById:async()=>({status:'pending',attempts:0,tiktok_url:'https://www.tiktok.com/@test/video/123',user_hint:JSON.parse(JSON.stringify(hint))}),claimSubmission:async()=>1},'@/lib/config/pipeline':{QUEUE_CONFIG:{maxConcurrentDrains:1}},'./processor':{processSubmission:async(_id:any,_url:any,value:any)=>{received=value;return{success:false};}},'./aggregator':{},'@/lib/dishes/aggregate':{},'@/lib/trends/recompute':{}});
    await worker.drainSubmission('job');assert.deepEqual(received,hint);
  });
  await check('omitted oEmbed metadata does not erase a cached caption',async()=>{
    const row:any={caption};const q=loadSource('lib/supabase/queries.ts',{'./client':{supabase:{from:()=>({update(p:any){Object.assign(row,p);return{eq:async()=>({error:null})};}})}},'@/lib/config/pipeline':{QUEUE_CONFIG:{},isTerminalStatus:()=>false}});
    await q.updateSubmissionWithTikTokData('job',{caption:'',videoId:'123'});assert.equal(row.caption,caption);
  });
  await check('the New API requests multiple branches and validates their actual types',async()=>{
    let request:any;
    const places=loadSource('lib/google/places.ts',{'axios':{default:{post:async(_url:any,body:any,options:any)=>{request={body,options};return{data:{places:[1,2].map(n=>({id:`branch-${n}`,displayName:{text:'Yaseen Shawarma'},formattedAddress:`${n} Main St, Mississauga, ON, Canada`,addressComponents:[{longText:'Mississauga',types:['locality']}],types:['restaurant'],businessStatus:'OPERATIONAL'}))}};}}},'@/lib/geo/gta':{GTA_CENTER:{latitude:43.7,longitude:-79.4},isGta:()=>true,resolveGtaCity:()=>null}},{process:{env:{GOOGLE_PLACES_API_VERSION:'new',GOOGLE_PLACES_API_KEY:'offline-fixture'}}});
    const result=await places.findRestaurant('Yaseen Shawarma','Mississauga');assert.equal(request.body.maxResultCount,5);assert.equal(request.body.includedType,undefined);assert.ok(request.options.headers['X-Goog-FieldMask'].includes('places.types'));assert.equal(result.ambiguous,true);assert.equal(result.locationVerified,false);
  });
  await check('a Places provider error is not disguised as restaurant not found',async()=>{
    const places=loadSource('lib/google/places.ts',{'axios':{default:{get:async()=>{throw new Error('provider unavailable');}}},'@/lib/geo/gta':{GTA_CENTER:{latitude:43.7,longitude:-79.4},isGta:()=>true,resolveGtaCity:()=>null}},{process:{env:{GOOGLE_PLACES_API_KEY:'offline-fixture'}}});
    await assert.rejects(()=>places.findRestaurant('Yaseen Shawarma','Mississauga'),/provider unavailable/);
  });
  await check('legacy address formatting cannot block a city verified by Place Details',async()=>{
    let requests=0;const address='5030 Maingate Dr Unit #5، Mississauga, ON L4W 1N5';
    const places=loadSource('lib/google/places.ts',{'axios':{default:{get:async(url:string)=>{requests++;return{data:url.includes('/textsearch/')?{status:'OK',results:[{place_id:'verified-place',name:'Yaseen’s Shawarma',formatted_address:address,types:['restaurant'],business_status:'OPERATIONAL'}]}:{status:'OK',result:{name:'Yaseen’s Shawarma',formatted_address:address,types:['restaurant'],business_status:'OPERATIONAL',address_components:[{long_name:'Mississauga',types:['locality']}],geometry:{location:{lat:43.63,lng:-79.62}}}}};}}},'@/lib/geo/gta':{GTA_CENTER:{latitude:43.7,longitude:-79.4},isGta:()=>true,resolveGtaCity:()=>null}},{process:{env:{GOOGLE_PLACES_API_KEY:'offline-fixture'}}});
    const result=await places.findRestaurant('Yaseen Shawarma','Mississauga');assert.equal(requests,2);assert.equal(result.locationVerified,true);assert.equal(result.city,'Mississauga');assert.equal(result.placeId,'verified-place');
  });
  await check('a transcript cache error prevents another paid transcript request',async()=>{
    let requests=0;const chain:any={select(){return chain;},eq(){return chain;},not(){return chain;},limit(){return chain;},maybeSingle:async()=>({error:{message:'offline'}})};
    const transcript=loadSource('lib/pipeline/transcript.ts',{'@/lib/supabase/client':{supabase:{from:()=>chain}},'@/lib/config/transcript':{TRANSCRIPT_CONFIG:{enabled:true,captionLengthFloor:0}}},{process:{env:{SUPADATA_API_KEY:'offline-fixture'}},fetch:async()=>{requests++;}});
    await assert.rejects(()=>transcript.fetchTranscript('https://www.tiktok.com/@test/video/123',{videoId:'123',captionLength:0}),/cache/);assert.equal(requests,0);
  });
  console.log(`Resolution checks: ${passed} passed`);
}
run().catch(error=>{console.error(error);process.exitCode=1;});
