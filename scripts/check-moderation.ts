/** Offline behavior checks; no provider requests, real reports or accounts. */
import assert from 'node:assert/strict';
import { feedbackAuthorRef, isObjectionableText } from '../lib/moderation';
import { loadSource, processorFixture } from './check-transcript';

let passed = 0;
const restaurantId = '11111111-1111-4111-8111-111111111111';
const contentId = '22222222-2222-4222-8222-222222222222';
const authorId = '33333333-3333-4333-8333-333333333333';
const replies = {
  badRequest: (error: string) => ({status:400,body:{error}}),
  notFound: (error: string) => ({status:404,body:{error}}),
  unauthorized: (error: string) => ({status:401,body:{error}}),
  serverError: () => ({status:500,body:{error:'Something went wrong'}}),
  created: (body: unknown) => ({status:201,body}),
  ok: (body: unknown) => ({status:200,body}),
};
async function check(label: string, body: () => unknown) { await body();passed++;console.log('PASS',label); }

function reportFixture(options: {userId?:string;target?:boolean;insertError?:boolean;limited?:boolean}={}) {
  const inserts:any[]=[];const filters:any[]=[];
  const api=loadSource('app/api/reports/route.ts',{
    '@/lib/supabase/client':{supabase:{from(table:string){const chain:any={select(){return chain;},eq(key:string,value:any){filters.push([key,value]);return chain;},maybeSingle:async()=>({data:options.target===false?null:{id:contentId}}),insert:async(row:any)=>{assert.equal(table,'content_reports');inserts.push(row);return{error:options.insertError?{}:null};}};return chain;}}},
    '@/lib/auth/verify':{getAuthedUser:async()=>options.userId?{id:options.userId}:null},
    '@/lib/http/respond':replies,
    '@/lib/http/ratelimit':{clientKey:()=> 'offline-caller',inMemoryLimit:()=>({allowed:!options.limited,retryAfterSeconds:60}),tooManyRequests:()=>({status:429})},
  });
  return {inserts,filters,post:(body:any)=>api.POST({json:async()=>body})};
}

function feedbackFixture() {
  let writes=0;
  const feedback=[{id:contentId,user_id:authorId,rating:1,would_return:false,comment:'Terrible service and cold rice.',dish:'shawarma'}];
  const api=loadSource('app/api/restaurants/[id]/feedback/route.ts',{
    '@/lib/supabase/client':{supabase:{from(table:string){const chain:any={select(){return chain;},eq(){return chain;},order(){return chain;},limit:async()=>({data:feedback}),maybeSingle:async()=>({data:table==='restaurants'?{id:restaurantId}:null}),upsert:async()=>{writes++;return{error:null};}};return chain;}}},
    '@/lib/auth/verify':{getAuthedUser:async()=>({id:authorId})},
    '@/lib/trends/recompute':{recomputeExperienceSignals:async()=>{}},
    '@/lib/moderation':{feedbackAuthorRef,isObjectionableText},
    '@/lib/http/respond':replies,
  });
  return {get writes(){return writes;},feedback,post:(comment:string,dish='shawarma')=>api.POST({json:async()=>({rating:1,comment,dish})},{params:Promise.resolve({id:restaurantId})}),get:()=>api.GET({},{params:Promise.resolve({id:restaurantId})})};
}

async function run() {
  await check('normal negative food criticism remains allowed',async()=>{
    const f=feedbackFixture();assert.equal((await f.post('Cold rice, dry meat and terrible service. I would not return.')).status,201);assert.equal(f.writes,1);
  });
  await check('threats and abusive free text are rejected before public writes',async()=>{
    const f=feedbackFixture();assert.equal((await f.post('I will kill you')).status,400);assert.equal(f.writes,0);
    assert.equal((await f.post('A review','f\u200buck you')).status,400);assert.equal(f.writes,0);
  });
  await check('feedback does not become an advertising-link surface',()=>{
    assert.equal(isObjectionableText('Go to https://example.invalid for a deal'),true);assert.equal(isObjectionableText('The killer curry was delicious'),false);
  });
  await check('public feedback provides stable blocking references without authentication IDs',async()=>{
    const f=feedbackFixture();const result=await f.get();const row=result.body.feedback[0];
    assert.equal(row.id,contentId);assert.equal(row.authorRef,feedbackAuthorRef(authorId));assert.equal(row.user_id,undefined);assert.notEqual(row.authorRef,authorId);assert.notEqual(feedbackAuthorRef('other-user'),row.authorRef);assert.equal(feedbackAuthorRef(null),null);
  });
  await check('old abusive text is not displayed while its numeric rating remains',async()=>{
    const f=feedbackFixture();f.feedback[0].comment='kill yourself';const result=await f.get();assert.equal(result.body.feedback[0].comment,null);assert.equal(result.body.feedback[0].rating,1);
  });
  await check('an anonymous report really inserts its validated content target',async()=>{
    const f=reportFixture();const result=await f.post({restaurantId,contentType:'review',contentId,reason:'rights'});
    assert.equal(result.status,201);assert.equal(result.body.reported,true);assert.equal(f.inserts.length,1);assert.equal(f.inserts[0].reported_by,null);assert.ok(f.filters.some(([key,value])=>key==='restaurant_id'&&value===restaurantId));
  });
  await check('signed-in reports derive their reporter identity from verified auth',async()=>{
    const f=reportFixture({userId:authorId});await f.post({restaurantId,contentType:'feedback',contentId,reason:'abuse',reported_by:'forged'});assert.equal(f.inserts[0].reported_by,authorId);
  });
  await check('bad reasons and missing or mismatched targets are never inserted',async()=>{
    const f=reportFixture();assert.equal((await f.post({restaurantId,contentType:'review',contentId,reason:'arbitrary'})).status,400);assert.equal(f.inserts.length,0);
    const gone=reportFixture({target:false});assert.equal((await gone.post({restaurantId,contentType:'review',contentId,reason:'spam'})).status,404);assert.equal(gone.inserts.length,0);
  });
  await check('a failed database write never returns report success',async()=>{
    const f=reportFixture({insertError:true});const result=await f.post({restaurantId,contentType:'review',contentId,reason:'abuse'});assert.equal(result.status,500);assert.notEqual(result.body.reported,true);
  });
  await check('a throttled report cannot reach the moderation queue',async()=>{
    const f=reportFixture({limited:true});assert.equal((await f.post({restaurantId,contentType:'review',contentId,reason:'spam'})).status,429);assert.equal(f.inserts.length,0);
  });
  await check('unsafe submitted text is rejected before extraction or restaurant/review writes',async()=>{
    const f=processorFixture('A restaurant review','ok','Threatening content',null,{classification:{isRestaurantReview:true,isSafeToPublish:false,confidence:1,contentType:'restaurant_review'}});
    assert.equal((await f.run()).success,false);assert.equal(f.calls.filter(c=>c.name==='classify').length,1);assert.ok(!f.calls.some(c=>['extract','places','createRestaurant','createReview'].includes(c.name)));assert.match(f.calls.find(c=>c.name==='status')?.args[2].rejectionReason,/community/);
  });
  await check('classification without a safety decision cannot silently publish',async()=>{
    const classifier=loadSource('lib/gemini/classify.ts',{'./client':{MODELS:{classify:'offline'},generateJSON:async()=>({isRestaurantReview:true})}});
    await assert.rejects(()=>classifier.classifyContent('review','test'),/Invalid classification response/);
  });
  console.log(`Moderation checks: ${passed} passed`);
}
run().catch(error=>{console.error(error);process.exitCode=1;});
