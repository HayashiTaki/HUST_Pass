import test from 'node:test';
import assert from 'node:assert/strict';
import { activateAutofill, cancelActivation, debuggerDetached } from '../src/activation.ts';

function mock(options: { active?: boolean; point?: boolean; denied?: boolean; slow?: boolean; cancelOnPress?: boolean; move?: boolean }={}) {
  const calls: string[]=[];let points=0;
  const previous=globalThis.chrome;
  globalThis.chrome={
    tabs:{
      query:async()=>[{id:options.active===false ? 2 : 1}],
      sendMessage:async(_tab:number,_message:unknown,selection:{documentId:string})=>{
        assert.equal(selection.documentId,'document-1');points++;
        return {valid:options.point!==false,url:'https://pass.hust.edu.cn/cas/login?service=x',x:options.move && points>2 ? 60 : 50,y:20,width:100,height:100};
      },
    },
    debugger:{
      attach:async()=>{calls.push('attach');if(options.denied)throw new Error('Cannot attach');if(options.slow)await new Promise(r=>setTimeout(r,5100));},
      detach:async()=>{calls.push('detach');},
      sendCommand:async(_target:unknown,method:string,params:{type:string})=>{
        assert.equal(method,'Input.dispatchMouseEvent');calls.push(params.type);
        if(options.cancelOnPress && params.type==='mousePressed')assert.equal(debuggerDetached(1),true);
      },
    },
  } as unknown as typeof chrome;
  return {calls,restore:()=>{globalThis.chrome=previous;}};
}
test('activation is one press/release pair and always detaches',async()=>{
  const m=mock();try{await activateAutofill(1,'document-1','token',async()=>true);assert.deepEqual(m.calls,['attach','mousePressed','mouseReleased','detach']);}finally{m.restore();}
});
test('stale, background and obstructed targets never attach or click',async()=>{
  for(const options of [{active:false},{point:false},{}]) {
    const m=mock(options);try{
      await assert.rejects(activateAutofill(1,'document-1','token',async()=>Object.keys(options).length>0));
      assert.deepEqual(m.calls,[]);
    }finally{m.restore();}
  }
});
test('attach denial does not detach somebody else\'s debugger',async()=>{
  const m=mock({denied:true});try{
    await assert.rejects(activateAutofill(1,'document-1','token',async()=>true),/调试权限/);
    assert.deepEqual(m.calls,['attach']);
  }finally{m.restore();}
});
test('user detach and moving input cancel the remaining click commands',async()=>{
  for(const options of [{cancelOnPress:true},{move:true}]) {
    const m=mock(options);try{
      await assert.rejects(activateAutofill(1,'document-1','token',async()=>true));
      assert.deepEqual(m.calls,['attach','mousePressed','detach']);
    }finally{m.restore();}
  }
});
test('late attach after timeout is detached without sending input',async()=>{
  const m=mock({slow:true});try{
    await assert.rejects(activateAutofill(1,'document-1','token',async()=>true),/超时/);
    await new Promise(r=>setTimeout(r,250));
    assert.deepEqual(m.calls,['attach','detach']);
  }finally{m.restore();}
});
test('cancellation before attachment is honored',async()=>{
  const m=mock();try{
    await assert.rejects(activateAutofill(1,'document-1','token',async()=>{cancelActivation(1);return false;}));
    assert.deepEqual(m.calls,[]);
  }finally{m.restore();}
});
