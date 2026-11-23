export default {
  test: {
    include: ['.build/**/*.{test,spec}.{js,ts,mjs,cjs,mts,cts,jsx,tsx}'],
    exclude: ['**/node_modules/**', '**/.git/**', '.build/evidence/**', '.build/**/snapshot/**'],
  },
};
