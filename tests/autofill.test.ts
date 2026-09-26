import test from 'node:test';
import assert from 'node:assert/strict';
import { credentialState } from '../src/autofill.ts';

const field=(value:string,autofill=false,unsupported=false)=>({value,matches:(selector:string)=>{
  if(unsupported && selector===':autofill') throw new Error('Unsupported selector');
  return autofill;
}} as HTMLInputElement);
test('distinguish empty, native preview and materialized credentials',()=>{
  assert.equal(credentialState(null,null),'missing');
  assert.equal(credentialState(field(''),field('')),'missing');
  assert.equal(credentialState(field('user'),field('')),'missing');
  assert.equal(credentialState(field('',true),field('',true)),'preview');
  assert.equal(credentialState(field('user'),field('',true)),'preview');
  assert.equal(credentialState(field('',true,true),field('',true,true)),'preview');
  assert.equal(credentialState(field('user'),field('password')),'ready');
});
