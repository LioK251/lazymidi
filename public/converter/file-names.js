(function () {
  'use strict';
  const suffix = /_transkun(?=(?:_\d+)?(?:_sheets|_hands)?(?:\.(?:mid|midi|txt))?$)/i;
  window.ConverterNames = {
    display: name => name.replace(suffix, ''),
    download: name => name.replace(suffix, '_lazymidi'),
  };
})();
