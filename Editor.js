define([
	"dojo/_base/kernel",
	"dojo/_base/lang",
	"dojo/on",
	"dojo/aspect",
	"dojo/has",
	"./Grid",
	"put-selector/put",
	"dojo/_base/sniff"
], function(kernel, lang, on, aspect, has, Grid, put){

var activeCell, activeValue; // tracks cell currently being edited, and its value

function updateInputValue(input, value){
	// common code for updating value of a standard input
	input.value = value;
	if(input.type == "radio" || input.type == "checkbox"){
		input.checked = !!value;
	}
}

function dataFromValue(value, oldValue){
	// Default logic for translating values from editors;
	// tries to preserve type if possible.
	if(typeof oldValue == "number"){
		value = isNaN(value) ? value : parseFloat(value);
	}else if(typeof oldValue == "boolean"){
		value = value == "true" ? true : value == "false" ? false : value;
	}else if(oldValue instanceof Date){
		var asDate = new Date(value);
		value = isNaN(asDate.getTime()) ? value : asDate;
	}
	return value;
}

// intermediary frontend to dataFromValue for HTML and widget editors
function dataFromEditor(column, cmp){
	if(typeof cmp.get == "function"){ // widget
		return dataFromValue(cmp.get("value"));
	}else{ // HTML input
		return dataFromValue(
			cmp[cmp.type == "checkbox" || cmp.type == "radio"  ? "checked" : "value"]);
	}
}

function setProperty(grid, cellElement, oldValue, value){
	// Updates dirty hash and fires dgrid-datachange event for a changed value.
	var cell, row, column;
	if(oldValue.valueOf() != value.valueOf()){
		cell = grid.cell(cellElement);
		row = cell.row;
		column = cell.column;
		if(column.field && row){
			// TODO: remove rowId in lieu of cell (or grid.row/grid.cell)
			// (keeping for the moment for back-compat, but will note in changes)
			if(on.emit(cellElement, "dgrid-datachange", {
						grid: this,
						cell: cell,
						rowId: row.id,
						oldValue: oldValue,
						value: value,
						bubbles: true,
						cancelable: true
					})){
				if (grid.updateDirty){
					// for OnDemandGrid: update dirty data, and save if autoSave is true
					grid.updateDirty(row.id, column.field, value);
					// perform auto-save (if applicable) in next tick to avoid
					// unintentional mishaps due to order of handler execution
					column.autoSave && setTimeout(function(){ grid._trackError("save"); }, 0);
				}
			}else{
				// else keep the value the same
				return oldValue;
			}
		}
	}
	return value;
}

// intermediary frontend to setProperty for HTML and widget editors
function setPropertyFromEditor(grid, column, cmp) {
	var value;
	if(!cmp.isValid || cmp.isValid()){
		value = setProperty(grid, (cmp.domNode || cmp).parentNode,
			activeCell ? activeValue : cmp._dgridLastValue,
			dataFromEditor(column, cmp));
		
		if(activeCell){ // for Editors with editOn defined
			activeValue = value;
		}else{ // for always-on Editors, update _dgridLastValue immediately
			cmp._dgridLastValue = value;
		}
	}
}

// editor creation/hookup/placement logic

function createEditor(column){
	// Creates an editor instance based on column definition properties,
	// and hooks up events.
	var editor = column.editor,
		editOn = column.editOn,
		grid = column.grid,
		isWidget = typeof editor != "string", // string == standard HTML input
		args, cmp, node, putstr, handleChange;
	
	args = column.editorArgs || {};
	if(typeof args == "function"){ args = args.call(grid, column); }
	
	if(isWidget){
		cmp = new editor(args);
		node = cmp.focusNode || cmp.domNode;
		
		// Add dgrid-input to className to make consistent with HTML inputs.
		// (Can't do this using className argument to constructor; causes issues)
		node.className += " dgrid-input";
		
		// For editOn Editors, connect to onBlur rather than onChange, since
		// the latter is delayed by setTimeouts in Dijit and will fire too late.
		cmp.connect(cmp, editOn ? "onBlur" : "onChange", function(){
			if(!cmp._dgridIgnoreChange){
				setPropertyFromEditor(grid, column, this);
			}
		});
	}else{
		handleChange = function(evt){
			var target = evt.target;
			if("_dgridLastValue" in target && target.className.indexOf("dgrid-input") > -1){
				setPropertyFromEditor(grid, column, target);
			}
		};

		// considerations for standard HTML form elements
		if(!column.grid._hasInputListener){
			// register one listener at the top level that receives events delegated
			grid._hasInputListener = true;
			grid.on("change", function(evt){ handleChange(evt); });
			// also register a focus listener
		}
		
		putstr = editor == "textarea" ? "textarea" :
			"input[type=" + editor + "]";
		cmp = node = put(putstr + ".dgrid-input", lang.mixin({
			name: column.field,
			tabIndex: isNaN(column.tabIndex) ? -1 : column.tabIndex
		}, args));
		
		if(has("ie") < 9 || (has("ie") && has("quirks"))){
			// IE<9 / quirks doesn't fire change events for all the right things,
			// and it doesn't bubble.
			if(editor == "radio" || editor == "checkbox"){
				// listen for clicks since IE doesn't fire change events properly for checks/radios
				on(cmp, "click", function(evt){ handleChange(evt); });
			}else{
				on(cmp, "change", function(evt){ handleChange(evt); });
			}
		}
	}
	
	// XXX: stop mousedown propagation to prevent confusing Keyboard mixin logic
	// with certain widgets; perhaps revising KB's `handledEvent` would be better.
	on(node, "mousedown", function(evt){ evt.stopPropagation(); });
	
	return cmp;
}

function createSharedEditor(column, originalRenderCell){
	// Creates an editor instance with additional considerations for
	// shared usage across an entire column (for columns with editOn specified).
	
	var cmp = createEditor(column),
		isWidget = cmp.domNode,
		node = cmp.domNode || cmp,
		focusNode = cmp.focusNode || node,
		reset = isWidget ?
			function(){ cmp.set("value", cmp._dgridLastValue); } :
			function(){
				updateInputValue(cmp, cmp._dgridLastValue);
				// call setProperty again in case we need to revert a previous change
				setPropertyFromEditor(column.grid, column, cmp);
			},
		keyHandle;
	
	function onblur(){
		var parentNode = node.parentNode,
			renderedNode;
		
		// remove the editor from the cell
		parentNode.removeChild(node);
		
		// pass new value to original renderCell implementation for this cell
		Grid.appendIfNode(parentNode, originalRenderCell(
			column.grid.row(parentNode).data, activeValue, parentNode));
		
		// reset state now that editor is deactivated
		activeCell = activeValue = null;
		column._editorBlurHandle.pause();
	}
	
	function dismissOnKey(evt){
		// Contains logic for reacting to enter/escape keypresses to save/cancel edits.
		// Returns boolean specifying whether this key event should dismiss the field.
		var key = evt.keyCode || evt.which;
		
		if(key == 27){ // escape: revert + dismiss
			reset();
			activeValue = cmp._dgridLastValue;
			focusNode.blur();
		}else if(key == 13 && column.dismissOnEnter !== false){ // enter: dismiss
			// FIXME: Opera is "reverting" even in this case
			focusNode.blur();
		}
	}
	
	// hook up enter/esc key handling
	keyHandle = on(focusNode, "keydown", dismissOnKey);
	
	// hook up blur handler, but don't activate until widget is activated
	(column._editorBlurHandle = on.pausable(cmp, "blur", onblur)).pause();
	
	return cmp;
}

function showEditor(cmp, column, cell, value){
	// Places a shared editor into the newly-active cell in the column.
	// Also called when rendering an editor in an "always-on" Editor column.
	
	var grid = column.grid,
		editor = column.editor,
		isWidget = cmp.domNode;
	
	// for regular inputs, we can update the value before even showing it
	if(!isWidget){ updateInputValue(cmp, value); }
	
	cell.innerHTML = "";
	put(cell, cmp.domNode || cmp);
	
	if(isWidget){
		// For widgets, ensure startup is called before setting value,
		// to maximize compatibility with flaky widgets like dijit/form/Select.
		if (!cmp._started){ cmp.startup(); }
		
		// Set value, but ensure it isn't processed as a user-generated change.
		// (Clear flag on a timeout to wait for delayed onChange to fire first)
		cmp._dgridIgnoreChange = true;
		cmp.set("value", value);
		setTimeout(function(){ cmp._dgridIgnoreChange = false; }, 0);
	}
	// track previous value for short-circuiting or in case we need to revert
	cmp._dgridLastValue = value;
	// if this is an Editor with editOn, also reset activeValue
	if(activeCell){ activeValue = value; }
}

// Editor column plugin function

return function(column, editor, editOn){
	// summary:
	//		Adds editing capability to a column's cells.
	
	var originalRenderCell = column.renderCell || Grid.defaultRenderCell,
		isWidget, cleanupAdded;
	
	// accept arguments as parameters to Editor function, or from column def,
	// but normalize to column def.
	column.editor = editor = editor || column.editor;
	column.editOn = editOn = editOn || column.editOn;
	
	isWidget = typeof editor != "string";
	
	// warn for widgetArgs -> editorArgs; TODO: remove @ 1.0
	if (column.widgetArgs) {
		kernel.deprecated("column.widgetArgs", "use column.editorArgs instead",
			"dgrid 1.0");
		column.editorArgs = column.widgetArgs;
	}
	
	column.renderCell = editOn ? function(object, value, cell, options){
		// On first run, create one shared widget/input which will be swapped into
		// the active cell.
		if(!column.editorInstance){
			column.editorInstance = createSharedEditor(column, originalRenderCell);
		}
		
		if (!cleanupAdded && isWidget) {
			cleanupAdded = true;
			// clean up shared widget instance when the grid is destroyed
			aspect.before(column.grid, "destroy", function(){
				column.editorInstance.destroyRecursive();
			});
		}
		
		// TODO: Consider using event delegation
		// (Would require using dgrid's focus events for activating on focus,
		// which we already advocate in README for optimal use)
		
		// in IE<8, cell is the child of the td due to the extra padding node
		on(cell.tagName == "TD" ? cell : cell.parentNode,
				editOn, function(){
			var cmp = column.editorInstance,
				grid = column.grid,
				field = column.field,
				row, dirty, value;
			
			if(activeCell != this &&
					(!column.canEdit || column.canEdit(object, value))){
				activeCell = this;
				
				// retrieve latest value; if retrieving from row, run through column.get
				row = grid.row(cell);
				dirty = grid.dirty && grid.dirty[row.id];
				value = (dirty && field in dirty) ? dirty[field] :
					column.get ? column.get(row.data) : row.data[field];
				showEditor(cmp, column, cell, value);
				
				// focus / blur-handler-resume logic is surrounded in a setTimeout
				// to play nice with Keyboard's dgrid-cellfocusin as an editOn event
				setTimeout(function(){
					// focus the newly-placed control
					cmp.focus && cmp.focus(); // supported by form widgets and HTML inputs
					// resume blur handler once editor is focused
					column._editorBlurHandle && column._editorBlurHandle.resume();
				}, 0);
			}
		});
		// initially render content in non-edit mode
		return originalRenderCell(object, value, cell, options);
	} : function(object, value, cell, options){
		// always-on: create editor immediately upon rendering each cell
		var grid = column.grid,
			cmp = createEditor(column);
		showEditor(cmp, column, cell, value);
		
		if(isWidget){
			// maintain reference for later cleanup
			cell.widget = cmp;
			
			if(!cleanupAdded){
				cleanupAdded = true;
				
				// add advice for cleaning up widgets in this column
				aspect.before(grid, "removeRow", function(rowElement){
					// destroy our widget during the row removal operation
					var cellElement = grid.cell(rowElement, column.id).element,
						widget = (cellElement.contents || cellElement).widget;
					widget && widget.destroyRecursive();
				});
			}
		}
	};
	
	return column;
};
});
