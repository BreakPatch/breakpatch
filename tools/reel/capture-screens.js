const { chromium } = require('playwright-core'); const fs=require('fs');
const DESC='Describe the next step, for example: click the Done button';
const R={};require("fs").mkdirSync("raw",{recursive:true});
(async()=>{
  const b = await chromium.launch({...(process.env.CHROMIUM?{executablePath:process.env.CHROMIUM}:{}),args:['--no-sandbox']});
  async function fresh(){
    const ctx = await b.newContext({viewport:{width:1280,height:800},deviceScaleFactor:2,colorScheme:'dark'});
    const pg = await ctx.newPage(); pg.on('pageerror',e=>console.log('ERR',e.message));
    await pg.clock.install({time:new Date(2026,8,24,15,52)});
    await pg.goto((process.env.APP_URL||'http://localhost:1420/')+'?demo&ready&signedin&theme=dark'); await pg.waitForTimeout(1300);
    const ok=pg.getByRole('button',{name:'OK'}); if(await ok.count()) await ok.first().click();
    return pg;
  }
  const shot=async(pg,n)=>{await pg.mouse.move(2,2);await pg.evaluate('document.activeElement&&document.activeElement.blur&&document.activeElement.blur()');await pg.waitForTimeout(500);await pg.screenshot({path:`raw/${n}.png`});console.log('shot',n)};
  const rect=async(loc,name)=>{try{const bb=await loc.first().boundingBox({timeout:3000});R[name]=bb}catch(e){console.log('no rect',name)}};
  const openApp=async(pg,name)=>{await pg.getByText('Web app',{exact:true}).first().click();await pg.waitForTimeout(600);if(name){await pg.getByText(name,{exact:true}).first().click();await pg.waitForTimeout(1200)}};
  let pg=await fresh(); await shot(pg,'home'); await openApp(pg,null); await shot(pg,'tests'); await pg.close();
  pg=await fresh(); await openApp(pg,'Create a project'); await shot(pg,'rec_idle');
  await rect(pg.getByPlaceholder(DESC),'input'); await rect(pg.getByRole('button',{name:'Run'}),'runBtn');
  const box=pg.getByPlaceholder(DESC); await box.click(); await pg.mouse.move(2,2);
  const full='click the New project button';
  for(let n=0;n<=full.length;n++){ await box.fill(full.slice(0,n)); await pg.waitForTimeout(120); await pg.screenshot({path:`raw/type_${String(n).padStart(2,'0')}.png`,clip:{x:0,y:690,width:1280,height:110}}); }
  await box.press('Enter'); await pg.waitForTimeout(200); await pg.mouse.move(2,2); await pg.screenshot({path:'raw/rec_looking.png'});
  await pg.getByRole('button',{name:'Confirm'}).waitFor(); await pg.waitForTimeout(800);
  await rect(pg.getByRole('button',{name:'Confirm'}),'confirm'); await rect(pg.getByRole('button',{name:'Try again'}),'tryagain');
  await shot(pg,'rec_proposal');
  await pg.getByRole('button',{name:'Confirm'}).click(); await pg.waitForTimeout(1600); await shot(pg,'rec_confirmed');
  await rect(pg.getByText('Click New project',{exact:true}).last(),'newstep'); await pg.close();
  pg=await fresh(); await openApp(pg,'Create a project'); await pg.getByRole('button',{name:'Run'}).first().click();
  for(let i=0;i<14;i++){ await pg.waitForTimeout(450); await pg.mouse.move(2,2); await pg.screenshot({path:`raw/run_${String(i).padStart(2,'0')}.png`}); }
  await pg.close();
  pg=await fresh(); await openApp(pg,null); await pg.getByRole('tab',{name:'Runs'}).first().click(); await pg.waitForTimeout(900);
  await pg.getByText('Yesterday, 06:00').first().click(); await pg.waitForTimeout(1500);
  await rect(pg.getByRole('button',{name:'Re-record this step'}),'rerecord'); await rect(pg.getByRole('button',{name:/Copy/}),'copy'); await rect(pg.getByText("Couldn't find the Done button").first(),'reason'); await rect(pg.getByRole('button',{name:'Create issue'}),'issue');
  await shot(pg,'report_failed'); await pg.close();
  pg=await fresh(); await openApp(pg,null); await pg.getByRole('tab',{name:'Runs'}).first().click(); await pg.waitForTimeout(900);
  await pg.getByText('Passed with fixes').first().click(); await pg.waitForTimeout(1500);
  await rect(pg.getByRole('button',{name:'Accept new position'}),'accept'); await rect(pg.getByRole('button',{name:'Dismiss'}),'dismiss'); await rect(pg.getByText('The Done button had moved').first(),'fixedtitle');
  await shot(pg,'report_fixed'); await pg.close();
  pg=await fresh(); await pg.getByText('Suites',{exact:true}).first().click(); await pg.waitForTimeout(1200); await shot(pg,'suites'); await pg.close();
  pg=await fresh(); await pg.getByRole('button',{name:'Settings'}).first().click(); await pg.waitForTimeout(800); await pg.getByText('AI assistant').first().click(); await pg.waitForTimeout(800); await shot(pg,'ai'); await pg.close();
  fs.writeFileSync('rects.json',JSON.stringify(R,null,1)); console.log(R);
  await b.close();
})().catch(e=>{console.log('FAIL',e.message);process.exit(1)});
